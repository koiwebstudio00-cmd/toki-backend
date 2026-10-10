import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { authorizeNativeRead, executeNativeAction, type NativePermission, type NativeScope } from "./actions.js";
import * as service from "./service.js";
import * as orders from "./orders.js";
import {
  draftAddItemsSchema, draftDetailsSchema, draftItemQuantitySchema,
  handoffSchema, modifyOrderSchema, cancelOrderSchema, orderStatusQuery, productRefParam, refundDestinationSchema
} from "./schemas.js";

const empty = z.object({}).strict();
const search = z.object({ query: z.string().trim().max(120).default("") }).strict();
const scopeFields = { businessId: true, conversationId: true } as const;

/**
 * Server-only registry. The model never chooses tenant/contact/message IDs.
 * Confirmation, modification and cancellation require AI SDK approval; the
 * channel adapter supplies authenticated approvals as persistent proposals.
 */
export interface ChannelTools { requestApproval: (name: string, args: unknown) => Promise<unknown>; paymentProof: (orderCode?: string) => Promise<unknown>; catalogMessageId?: string }
export async function createNativeTools(scope: NativeScope, abortSignal?: AbortSignal, channel?: ChannelTools): Promise<ToolSet> {
  // A registry belongs to one turn. Queued tool calls must not outlive its budget.
  abortSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(abortSignal ? [abortSignal] : [])]);
  abortSignal.throwIfAborted();
  const settings = await authorizeNativeRead(scope);
  const tools: ToolSet = {};
  let serial: Promise<unknown> = Promise.resolve();
  let calls = 0;
  let awaitingApproval = false;
  const run = <T>(operation: () => Promise<T>) => {
    const result = serial.then(async () => {
      abortSignal?.throwIfAborted();
      if (++calls > 16) throw new Error("Se alcanzó el límite de herramientas de este turno.");
      return operation();
    });
    serial = result.catch(() => undefined);
    return result;
  };
  const read = <T>(permission: NativePermission, operation: () => Promise<T>) => run(async () => {
    try {
      await authorizeNativeRead(scope, permission);
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("SERVICE_UNAVAILABLE", "No se pudo consultar la información del negocio.");
    }
  });
  const write = (permission: NativePermission, toolName: string, args: unknown, execute: () => Promise<unknown>) =>
    run(() => {
      if (awaitingApproval) throw new ApiError("CONFLICT", "Esperá la confirmación pendiente antes de cambiar el pedido.");
      return executeNativeAction({ scope, permission, toolName, args, execute, abortSignal });
    });
  const approve = (name: string, args: unknown) => run(async () => {
    if (awaitingApproval) throw new ApiError("CONFLICT", "Ya hay una confirmación pendiente.");
    const result = await channel!.requestApproval(name, args);
    if ((result as { pendingApproval?: boolean })?.pendingApproval) awaitingApproval = true;
    return result;
  });

  tools.buscar_productos = tool({ description: "Busca productos disponibles con precios e identificadores reales del negocio.", inputSchema: search,
    execute: ({ query }) => read("read", () => service.searchProducts(scope.businessId, query, 10)) });
  tools.ver_producto = tool({ description: "Consulta las opciones, recargos y requisitos de un producto del negocio.", inputSchema: productRefParam.strict(),
    execute: ({ id }) => read("read", () => service.productDetail(scope.businessId, id)) });
  tools.buscar_faq = tool({ description: "Busca información del negocio para redactar una respuesta adecuada a esta conversación.", inputSchema: search,
    execute: ({ query }) => read("read", () => service.searchFaq(scope.businessId, query, 8)) });

  if (settings.enabledTools.includes("create_orders")) {
    tools.agregar_productos = tool({ description: "Agrega juntos los productos solicitados al borrador. Usá IDs del catálogo; Toki valida opciones y calcula precios. Repetir exactamente la misma llamada en este mensaje devuelve el resultado anterior.", inputSchema: draftAddItemsSchema.omit(scopeFields).strict(),
      execute: (args) => write("create_orders", "agregar_productos", args, () => service.draftAddItems({ ...args, ...scope })) });
    tools.cambiar_item = tool({ description: "Fija la cantidad de un ítem del borrador. Cero lo elimina.", inputSchema: draftItemQuantitySchema.omit(scopeFields).extend({ itemId: z.string().uuid() }).strict(),
      execute: (args) => write("create_orders", "cambiar_item", args, () => service.draftSetItemQuantity(scope.businessId, scope.conversationId, args.itemId, args.quantity)) });
    tools.datos_del_pedido = tool({ description: "Guarda datos del pedido que el cliente ya proporcionó; devuelve lo que falta preguntar.", inputSchema: draftDetailsSchema.omit(scopeFields).strict(),
      execute: (args) => write("create_orders", "datos_del_pedido", args, () => service.draftSetDetails({ ...args, ...scope })) });
    tools.descartar_pedido = tool({ description: "Descarta el borrador actual cuando el cliente lo pide. No cancela pedidos confirmados.", inputSchema: empty,
      execute: (args) => write("create_orders", "descartar_pedido", args, () => service.draftCancel(scope.businessId, scope.conversationId)) });
    tools.confirmar_pedido = tool({ description: "Solicita aprobación para confirmar el borrador después de mostrar su resumen y total. No se ejecuta hasta recibir una aprobación del canal.", inputSchema: empty, needsApproval: !channel,
      execute: (args) => channel ? approve("confirmar_pedido", args) : write("create_orders", "confirmar_pedido", args, () => service.confirmDraft(scope.businessId, scope.conversationId)) });
  }
  if (channel?.catalogMessageId && settings.enabledTools.includes("create_orders")) {
    // The complete checkout message is verified by the server; never rebuild it from prose.
    delete tools.agregar_productos; delete tools.cambiar_item; delete tools.datos_del_pedido; delete tools.descartar_pedido; delete tools.confirmar_pedido;
    tools.recibir_pedido_catalogo = tool({ description: "Prepara la confirmación de la solicitud WEB recibida del catálogo de Toki. Recupera exactamente sus productos, opciones, cupón y datos, verifica el mensaje completo y recalcula precios. Si el cliente la corrigió o retiró, no uses esta herramienta: pedile actualizar el carrito. No crea el pedido hasta que acepte el botón.", inputSchema: empty,
      execute: () => approve("recibir_pedido_catalogo", { sourceMessageId: channel.catalogMessageId }) });
  }
  if (settings.enabledTools.includes("order_status")) {
    tools.consultar_pedido = tool({ description: "Consulta el estado del pedido de este contacto; nunca pedidos de otro cliente.", inputSchema: orderStatusQuery.omit(scopeFields).strict(),
      execute: ({ orderCode }) => read("order_status", () => service.orderStatus(scope.businessId, scope.conversationId, orderCode)) });
  }
  if (settings.enabledTools.includes("modify_orders")) {
    tools.modificar_pedido = tool({ description: "Solicita aprobación para modificar un pedido existente. Toki valida su estado y recalcula los importes.", inputSchema: modifyOrderSchema.omit(scopeFields).strict(), needsApproval: !channel,
      execute: (args) => channel ? approve("modificar_pedido", args) : write("modify_orders", "modificar_pedido", args, () => orders.modifyOrder({ ...args, ...scope })) });
  }
  if (settings.enabledTools.includes("cancel_orders")) {
    tools.cancelar_pedido = tool({ description: "Solicita aprobación para cancelar el pedido indicado. Solo se ejecuta después de aprobar y si Toki permite cancelarlo.", inputSchema: cancelOrderSchema.omit(scopeFields).strict(), needsApproval: !channel,
      execute: (args) => channel ? approve("cancelar_pedido", args) : write("cancel_orders", "cancelar_pedido", args, () => orders.cancelOrder({ ...args, ...scope })) });
  }
  if (settings.handoffEnabled) {
    tools.derivar_a_persona = tool({ description: "Pasa esta conversación al equipo con un resumen útil. Tras el éxito, no sigas operando ni prometas tiempos de atención.", inputSchema: handoffSchema.omit({ businessId: true }).strict(),
      execute: (args) => write("handoff", "derivar_a_persona", args, () => orders.handoff({ ...args, ...scope })) });
  }
  if (channel && settings.enabledTools.includes("payment_proofs")) {
    tools.guardar_comprobante = tool({ description: "Guarda la imagen o PDF reciente recibido por WhatsApp como comprobante pendiente de revisión. Nunca acredita el pago ni verifica su autenticidad.",
      inputSchema: z.object({ orderCode: z.string().max(20).optional() }).strict(),
      execute: args => write("payment_proofs", "guardar_comprobante", args, () => channel.paymentProof(args.orderCode)) });
  }
  if (channel && settings.enabledTools.includes("refund_details")) {
    tools.datos_reembolso = tool({ description: "Registra el alias o CBU/CVU y titular que el cliente dio para un reembolso pendiente. No realiza transferencias.",
      inputSchema: refundDestinationSchema.innerType().omit(scopeFields).strict(),
      execute: args => write("refund_details", "datos_reembolso", args, () => orders.setRefundDestination(refundDestinationSchema.parse({ ...args, ...scope }))) });
  }
  // URLs and channel identity are never model inputs.
  return tools;
}
