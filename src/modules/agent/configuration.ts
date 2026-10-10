/** Stable capability IDs shared by settings, the prompt and tool authorization. */
export const AGENT_CAPABILITIES = [
  { id: "create_orders", label: "Tomar pedidos", description: "Armar un pedido y confirmarlo después de que el cliente acepte.", tools: ["agregar_productos", "cambiar_item", "datos_del_pedido", "descartar_pedido", "confirmar_pedido"] },
  { id: "order_status", label: "Consultar pedidos", description: "Consultar el estado de los pedidos del cliente.", tools: ["consultar_pedido"] },
  { id: "modify_orders", label: "Modificar pedidos", description: "Cambiar un pedido existente cuando Toki lo permita.", tools: ["modificar_pedido"] },
  { id: "cancel_orders", label: "Cancelar pedidos", description: "Cancelar un pedido permitido por Toki, con confirmación del cliente.", tools: ["cancelar_pedido"] },
  { id: "payment_proofs", label: "Recibir comprobantes", description: "Guardar comprobantes para que el negocio los revise. No acredita pagos.", tools: ["guardar_comprobante"] },
  { id: "refund_details", label: "Recibir datos para devoluciones", description: "Guardar el destino de una devolución pendiente. No transfiere dinero.", tools: ["datos_reembolso"] }
] as const;

export type AgentCapability = typeof AGENT_CAPABILITIES[number]["id"];
export const CAPABILITY_IDS = AGENT_CAPABILITIES.map((capability) => capability.id);

export const BOT_DEFAULTS = {
  isEnabled: true,
  botName: "Sofi",
  tone: "friendly",
  fallbackMessage: "Te derivo con una persona del equipo para que pueda ayudarte.",
  handoffEnabled: true,
  instructions: "",
  businessContext: "",
  enabledTools: [...CAPABILITY_IDS]
};

export const botSettingsSelect = {
  isEnabled: true, botName: true, tone: true, fallbackMessage: true, handoffEnabled: true,
  instructions: true, businessContext: true, enabledTools: true, updatedAt: true
} as const;

export function allowedToolNames(settings: { enabledTools: readonly string[]; handoffEnabled: boolean }) {
  return [
    "buscar_productos", "ver_producto", "buscar_faq",
    ...AGENT_CAPABILITIES.filter((capability) => settings.enabledTools.includes(capability.id)).flatMap((capability) => [...capability.tools]),
    ...(settings.handoffEnabled ? ["derivar_a_persona"] : [])
  ];
}
