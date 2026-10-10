// Agente v3, fase V1: contexto (reloj, carta, bot, pedido), ids cortos,
// búsqueda por palabras, vencimiento del borrador y Sofi por defecto.
// Plan: toki-agents/docs/12-plan-agente-v3.md.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import {
  buildClock,
  buildMenu,
  MENU_FULL_MAX_PRODUCTS,
  openingLabel,
  orderEta,
  shortRefs,
  statusLabel,
  toneLabel,
  type MenuProductInput
} from "../src/modules/agent/context.js";
import { DB_AVAILABLE, ownerDb, seedShop, TEST_AGENT_KEY } from "./helpers.js";

// ── Funciones puras ─────────────────────────────────────────────────────────

describe("agente v3: reloj del negocio", () => {
  const base = { timezone: "America/Argentina/Buenos_Aires", manualStatus: "auto" };

  it("abierto: dice a qué hora cierra", () => {
    const clock = buildClock({
      ...base,
      isOpen: true,
      nowLocal: "2026-09-25T20:15",
      windows: [{ date: "2026-09-25", opens: "19:00", closes: "23:30" }]
    });
    expect(clock.closes_at).toBe("23:30");
    expect(clock.next_open).toBeNull();
    expect(clock.now_label).toBe("viernes 25/09, 20:15");
  });

  it("cerrado a la tarde: abre hoy", () => {
    const clock = buildClock({
      ...base,
      isOpen: false,
      nowLocal: "2026-09-25T16:23",
      windows: [
        { date: "2026-09-24", opens: "19:00", closes: "23:30" },
        { date: "2026-09-25", opens: "19:00", closes: "23:30" }
      ]
    });
    expect(clock.next_open).toEqual({ at: "2026-09-25T19:00", label: "hoy a las 19:00" });
    expect(clock.closes_at).toBeNull();
  });

  it("horario cortado: entre turnos abre a la noche", () => {
    const clock = buildClock({
      ...base,
      isOpen: false,
      nowLocal: "2026-09-25T15:30",
      windows: [
        { date: "2026-09-25", opens: "12:00", closes: "15:00" },
        { date: "2026-09-25", opens: "20:00", closes: "23:59" }
      ]
    });
    expect(clock.next_open?.label).toBe("hoy a las 20:00");
  });

  it("turno que cruza la medianoche: a la 01:00 sigue abierto hasta las 02:00", () => {
    const clock = buildClock({
      ...base,
      isOpen: true,
      nowLocal: "2026-09-26T01:00",
      windows: [{ date: "2026-09-25", opens: "20:00", closes: "02:00" }]
    });
    expect(clock.closes_at).toBe("02:00");
  });

  it("cerrado hasta dentro de unos días: nombra el día", () => {
    const clock = buildClock({
      ...base,
      isOpen: false,
      nowLocal: "2026-09-25T23:45",
      windows: [{ date: "2026-09-28", opens: "12:00", closes: "15:00" }]
    });
    expect(clock.next_open?.label).toBe("el lunes 28/09 a las 12:00");
  });

  it("cerrado a mano desde el panel: no inventa una apertura", () => {
    const clock = buildClock({
      ...base,
      manualStatus: "closed",
      isOpen: false,
      nowLocal: "2026-09-25T16:00",
      windows: [{ date: "2026-09-25", opens: "19:00", closes: "23:30" }]
    });
    expect(clock.next_open).toBeNull();
  });

  it("etiquetas de apertura", () => {
    expect(openingLabel("2026-09-25", "2026-09-26", "12:00")).toBe("mañana a las 12:00");
  });
});

describe("agente v3: ids cortos", () => {
  it("usa 6 caracteres y alarga a 8 solo cuando chocan", () => {
    const a = "abcdef11-0000-4000-8000-000000000001";
    const b = "abcdef22-0000-4000-8000-000000000002";
    const c = "123456aa-0000-4000-8000-000000000003";
    const refs = shortRefs([a, b, c]);
    expect(refs.get(c)).toBe("123456");
    expect(refs.get(a)).toBe("abcdef11");
    expect(refs.get(b)).toBe("abcdef22");
  });

  it("si chocan también con 8, queda el UUID completo", () => {
    const a = "abcdef11-0000-4000-8000-000000000001";
    const b = "abcdef11-1111-4000-8000-000000000002";
    const refs = shortRefs([a, b]);
    expect(refs.get(a)).toBe(a);
    expect(refs.get(b)).toBe(b);
  });
});

describe("agente v3: carta", () => {
  const product = (i: number, category = "Pizzas"): MenuProductInput => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `Producto ${i}`,
    description: i === 1 ? "x".repeat(300) : null,
    price: 1000 + i,
    isFeatured: i <= 3,
    category: { name: category, sortOrder: category === "Pizzas" ? 1 : 2 },
    options: []
  });

  it(`hasta ${MENU_FULL_MAX_PRODUCTS} productos va completa y recorta descripciones largas`, () => {
    const menu = buildMenu([product(1), product(2, "Bebidas")], new Map());
    expect(menu.mode).toBe("full");
    if (menu.mode !== "full") return;
    expect(menu.categories.map((c) => c.name)).toEqual(["Pizzas", "Bebidas"]);
    expect(menu.categories[0]!.products[0]!.description!.length).toBeLessThanOrEqual(120);
  });

  it(`con más de ${MENU_FULL_MAX_PRODUCTS} va el resumen con destacados`, () => {
    const many = Array.from({ length: MENU_FULL_MAX_PRODUCTS + 1 }, (_, i) => product(i + 1));
    const menu = buildMenu(many, new Map());
    expect(menu.mode).toBe("summary");
    if (menu.mode !== "summary") return;
    expect(menu.categories[0]).toEqual({ name: "Pizzas", product_count: MENU_FULL_MAX_PRODUCTS + 1, price_from: 1001 });
    expect(menu.featured).toHaveLength(3);
  });
});

describe("agente v3: textos del pedido y del bot", () => {
  it("estado legible según la entrega", () => {
    expect(statusLabel("ready", "takeaway")).toBe("listo para retirar");
    expect(statusLabel("ready", "delivery")).toBe("listo, esperando al repartidor");
    expect(statusLabel("out_for_delivery", "delivery")).toBe("en camino");
  });

  it("hora estimada en la zona del negocio, solo para pedidos en curso", () => {
    const createdAt = "2026-09-25T23:30:00Z"; // 20:30 en Argentina
    const tz = "America/Argentina/Buenos_Aires";
    expect(orderEta({ status: "preparing", createdAt, estimatedMinutes: 40, timezone: tz })).toBe("21:10");
    expect(orderEta({ status: "delivered", createdAt, estimatedMinutes: 40, timezone: tz })).toBeNull();
  });

  it("tono: traduce los valores de fábrica y respeta el texto libre", () => {
    expect(toneLabel("friendly")).toBe("cercano y claro");
    expect(toneLabel("divertido y con emojis")).toBe("divertido y con emojis");
    expect(toneLabel(null)).toBe("cercano y claro");
  });
});

// ── Integración ─────────────────────────────────────────────────────────────

const app = buildApp();
const key = { "x-api-key": TEST_AGENT_KEY };

describe.runIf(DB_AVAILABLE)("agente v3 (integración)", () => {
  let s: Awaited<ReturnType<typeof seedShop>>;
  let conversationId: string;

  beforeEach(async () => {
    s = await seedShop("agente-v3");
    const conversation = await ownerDb().whatsappConversation.create({
      data: { businessId: s.businessId, contactId: "wa-v3", phone: "3815550000" }
    });
    conversationId = conversation.id;
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const context = async () =>
    (
      await request(app)
        .get(`/v1/agent/conversations/${conversationId}/context?businessId=${s.businessId}`)
        .set(key)
        .expect(200)
    ).body;

  /** Cerrado por horario toda la semana, salvo mañana de 10 a 12 (día especial). */
  async function closedUntilTomorrowAt10({ opensTomorrow = true } = {}) {
    const db = ownerDb();
    await db.business.update({ where: { id: s.businessId }, data: { manualStatus: "auto" } });
    await db.businessHour.updateMany({ where: { businessId: s.businessId }, data: { isOpen: false } });
    if (!opensTomorrow) return;
    const [row] = await db.$queryRaw<{ tomorrow: Date }[]>`
      select ((now() at time zone 'America/Argentina/Buenos_Aires')::date + 1) as tomorrow`;
    await db.businessSpecialHour.create({
      data: {
        businessId: s.businessId,
        date: row!.tomorrow,
        isClosed: false,
        opensAt: new Date("1970-01-01T10:00:00Z"),
        closesAt: new Date("1970-01-01T12:00:00Z")
      }
    });
  }

  const refOf = (body: { menu: { categories: { products: { name: string; ref: string }[] }[] } }, name: string) =>
    body.menu.categories.flatMap((c) => c.products).find((p) => p.name === name)!.ref;

  describe("contexto", () => {
    it("trae la carta completa con ids cortos y opciones", async () => {
      const body = await context();
      expect(body.menu.mode).toBe("full");
      const burger = body.menu.categories[0].products.find((p: { name: string }) => p.name === "Doble cheddar");
      expect(burger.ref).toBe(s.burgerId.slice(0, 6));
      expect(burger.price).toBe(10000);
      const punto = burger.options.find((o: { name: string }) => o.name === "Punto");
      expect(punto.required).toBe(true);
      expect(punto.values.map((v: { name: string }) => v.name)).toEqual(["A punto", "Jugosa"]);
    });

    it("no muestra productos sin stock ni de categorías apagadas", async () => {
      await ownerDb().product.update({ where: { id: s.burgerId }, data: { stockQuantity: 0 } });
      const oculta = await ownerDb().category.create({ data: { businessId: s.businessId, name: "Oculta", isActive: false } });
      await ownerDb().product.create({ data: { businessId: s.businessId, categoryId: oculta.id, name: "Secreto", price: 1 } });
      const text = JSON.stringify((await context()).menu);
      expect(text).not.toContain("Doble cheddar");
      expect(text).not.toContain("Secreto");
      expect(text).toContain("Gaseosa");
    });

    it("trae el reloj del negocio", async () => {
      const body = await context();
      // seedShop deja el local abierto a mano: sin hora de cierre ni de apertura.
      expect(body.clock.is_open).toBe(true);
      expect(body.clock.manual_status).toBe("open");
      expect(body.clock.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    it("cerrado por horario: dice cuándo abre", async () => {
      await closedUntilTomorrowAt10();
      const body = await context();
      expect(body.clock.is_open).toBe(false);
      expect(body.clock.next_open.label).toBe("mañana a las 10:00");
    });

    it("el asistente se llama Sofi por defecto", async () => {
      const bot = await ownerDb().botSettings.findUniqueOrThrow({ where: { businessId: s.businessId } });
      expect(bot.botName).toBe("Sofi");
      const body = await context();
      expect(body.bot.bot_name).toBe("Sofi");
      expect(body.bot.tone_label).toBe("cercano y claro");
    });

    it("respeta el nombre que eligió el negocio", async () => {
      await ownerDb().botSettings.update({ where: { businessId: s.businessId }, data: { botName: "Martu" } });
      expect((await context()).bot.bot_name).toBe("Martu");
    });

    it("el pedido activo trae el estado legible, la hora estimada y el seguimiento", async () => {
      await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ businessId: s.businessId, conversationId, productId: s.sodaId, quantity: 1 })
        .expect(200);
      await request(app)
        .patch("/v1/agent/draft")
        .set(key)
        .send({ businessId: s.businessId, conversationId, customerName: "Ana", orderType: "takeaway", paymentMethod: "cash" })
        .expect(200);
      await request(app).post("/v1/agent/draft/confirm").set(key).send({ businessId: s.businessId, conversationId }).expect(201);

      const order = (await context()).active_order;
      expect(order.status_label).toBe("recibido, esperando que el local lo acepte");
      expect(order.eta).toMatch(/^\d{2}:\d{2}$/);
      expect(order.track_url).toContain(`/order/${order.order_code}`);
    });
  });

  describe("ids cortos en las tools", () => {
    it("ver_producto y agregar_al_pedido aceptan los ids de la carta", async () => {
      const body = await context();
      const burgerRef = refOf(body, "Doble cheddar");
      const aPuntoRef = body.menu.categories[0].products
        .find((p: { name: string }) => p.name === "Doble cheddar")
        .options[0].values.find((v: { name: string }) => v.name === "A punto").ref;

      const detail = await request(app).get(`/v1/agent/products/${burgerRef}?businessId=${s.businessId}`).set(key).expect(200);
      expect(detail.body.producto.id).toBe(s.burgerId);

      const added = await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ businessId: s.businessId, conversationId, productId: burgerRef, quantity: 1, optionValueIds: [aPuntoRef] })
        .expect(200);
      expect(added.body.ok).toBe(true);
      expect(added.body.pedido.items[0].product_id).toBe(s.burgerId);
    });

    it("un id que no es del negocio no se resuelve", async () => {
      const otro = await seedShop("agente-v3-otro");
      // seedShop vacía la base: se rearma la conversación del primero.
      s = await seedShop("agente-v3");
      conversationId = (
        await ownerDb().whatsappConversation.create({ data: { businessId: s.businessId, contactId: "wa-v3" } })
      ).id;
      const res = await request(app)
        .get(`/v1/agent/products/${otro.burgerId.slice(0, 6)}?businessId=${s.businessId}`)
        .set(key)
        .expect(200);
      expect(res.body).toEqual({ ok: false, error: "No encontré ese producto en la carta." });
    });

    it("una opción inexistente se explica en vez de romper", async () => {
      const res = await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ businessId: s.businessId, conversationId, productId: s.sodaId, optionValueIds: ["ffffff"] })
        .expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/opciones/);
    });

    it("rechaza algo que no parece un id", async () => {
      await request(app).get(`/v1/agent/products/pizza?businessId=${s.businessId}`).set(key).expect(400);
    });
  });

  describe("búsqueda por palabras", () => {
    const search = async (q: string) =>
      (
        await request(app)
          .get(`/v1/agent/products/search?businessId=${s.businessId}&q=${encodeURIComponent(q)}`)
          .set(key)
          .expect(200)
      ).body as { name: string }[];

    beforeEach(async () => {
      const db = ownerDb();
      const ensaladas = await db.category.create({ data: { businessId: s.businessId, name: "Ensaladas" } });
      await db.product.create({
        data: { businessId: s.businessId, categoryId: ensaladas.id, name: "Ensalada César", description: "Con pollo grillado y croutons", price: 8500 }
      });
      await db.product.create({ data: { businessId: s.businessId, name: "Empanada de carne", price: 1200 } });
      await db.product.create({ data: { businessId: s.businessId, name: "Milanesa napolitana", price: 12000 } });
    });

    it("encuentra por palabras sueltas, no por la frase entera", async () => {
      expect((await search("ensalada de pollo"))[0]!.name).toBe("Ensalada César");
    });

    it("ignora acentos", async () => {
      expect((await search("cesar")).map((p) => p.name)).toContain("Ensalada César");
    });

    it("tolera el plural", async () => {
      expect((await search("tenés empanadas?")).map((p) => p.name)).toContain("Empanada de carne");
    });

    it("tolera un error de tipeo", async () => {
      expect((await search("milaneza")).map((p) => p.name)).toContain("Milanesa napolitana");
    });

    it("ordena por cuántas palabras coinciden", async () => {
      const names = (await search("milanesa napolitana con papas")).map((p) => p.name);
      expect(names[0]).toBe("Milanesa napolitana");
    });

    it("sin nada que coincida no devuelve cualquier cosa", async () => {
      expect(await search("sushi")).toEqual([]);
    });

    it("solo palabras vacías: devuelve la carta como antes", async () => {
      expect((await search("hola que tienen")).length).toBeGreaterThan(0);
    });

    it("preguntas frecuentes por palabras", async () => {
      await ownerDb().botFaq.create({
        data: { businessId: s.businessId, question: "¿Cuánto demora el envío?", answer: "Entre 30 y 45 minutos." }
      });
      const res = await request(app)
        .get(`/v1/agent/faq/search?businessId=${s.businessId}&q=${encodeURIComponent("cuanto tarda el envio")}`)
        .set(key)
        .expect(200);
      expect(JSON.stringify(res.body)).toMatch(/30 y 45/);
    });
  });

  describe("vencimiento del borrador", () => {
    const addSoda = () =>
      request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ businessId: s.businessId, conversationId, productId: s.sodaId, quantity: 1 })
        .expect(200);

    // El trigger set_updated_at pisa updated_at en cada UPDATE: para envejecer
    // el borrador hay que apagar los triggers en esa sola escritura.
    const ageDraft = (hours: number) =>
      ownerDb().$transaction([
        ownerDb().$executeRaw`set local session_replication_role = replica`,
        ownerDb().$executeRaw`
          update public.whatsapp_order_drafts
          set updated_at = now() - make_interval(hours => ${hours}::int)
          where conversation_id = ${conversationId}::uuid`
      ]);

    it("a las 4 h sin cambios se descarta", async () => {
      await addSoda();
      await ageDraft(5);
      const body = await context();
      expect(body.draft).toBeNull();
      const d = await ownerDb().whatsappOrderDraft.findFirstOrThrow({ where: { conversationId } });
      expect(d.status).toBe("cancelled");
    });

    it("antes de las 4 h sigue", async () => {
      await addSoda();
      await ageDraft(3);
      expect((await context()).draft.items).toHaveLength(1);
    });

    it("agregar un producto cuenta como cambio", async () => {
      await addSoda();
      await ageDraft(5);
      // El segundo alta toca el borrador (trigger de 0008) antes de que se lea el contexto.
      await addSoda();
      expect((await context()).draft.items).toHaveLength(2);
    });
  });

  describe("V2: borrador", () => {
    const ids = () => ({ businessId: s.businessId, conversationId });
    const addItems = (items: unknown) =>
      request(app).post("/v1/agent/draft/items").set(key).send({ ...ids(), items }).expect(200);
    const setQuantity = (itemId: string, quantity: number) =>
      request(app).patch(`/v1/agent/draft/items/${itemId}`).set(key).send({ ...ids(), quantity }).expect(200);

    it("carga varios productos en una llamada", async () => {
      const res = await addItems([
        { productId: s.burgerId.slice(0, 6), quantity: 1, optionValueIds: [s.aPuntoId.slice(0, 6)] },
        { productId: s.sodaId, quantity: 2 }
      ]);
      expect(res.body.ok).toBe(true);
      expect(res.body.resultados.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);
      expect(res.body.pedido.items).toHaveLength(2);
      expect(res.body.pedido.subtotal).toBe(15000);
    });

    it("un producto que falla no frena al resto y se explica", async () => {
      const res = await addItems([
        { productId: s.sodaId, quantity: 1 },
        { productId: s.burgerId, quantity: 1 } // falta el punto, que es obligatorio
      ]);
      expect(res.body.ok).toBe(false);
      expect(res.body.resultados[0].ok).toBe(true);
      expect(res.body.resultados[1]).toMatchObject({ ok: false });
      expect(res.body.resultados[1].error).toMatch(/Punto/);
      expect(res.body.pedido.items).toHaveLength(1);
    });

    it("acepta la lista como texto JSON (así la puede mandar n8n)", async () => {
      const res = await addItems(JSON.stringify([{ productId: s.sodaId, quantity: 3 }]));
      expect(res.body.pedido.items[0].quantity).toBe(3);
    });

    it("no carga en la conversación de otro negocio", async () => {
      const otro = await ownerDb().business.findFirstOrThrow({ where: { id: s.businessId } });
      const ajena = await ownerDb().whatsappConversation.create({ data: { businessId: otro.id, contactId: "wa-ajena" } });
      const res = await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ businessId: "00000000-0000-4000-8000-000000000000", conversationId: ajena.id, items: [{ productId: s.sodaId }] })
        .expect(200);
      expect(res.body).toEqual({ ok: false, error: "Conversacion invalida." });
    });

    it("cambia la cantidad de un item y con 0 lo saca", async () => {
      const added = await addItems([{ productId: s.sodaId, quantity: 1 }]);
      const itemId = added.body.pedido.items[0].id;

      const tres = await setQuantity(itemId, 3);
      expect(tres.body.ok).toBe(true);
      expect(tres.body.pedido.items[0]).toMatchObject({ quantity: 3, total_price: 7500 });

      const cero = await setQuantity(itemId, 0);
      expect(cero.body.ok).toBe(true);
      expect(cero.body.pedido.items).toHaveLength(0);
    });

    it("no pasa el stock del producto ni de la opción", async () => {
      const added = await addItems([
        { productId: s.burgerId, quantity: 1, optionValueIds: [s.aPuntoId, s.pancetaId] }
      ]);
      const itemId = added.body.pedido.items[0].id;
      expect((await setQuantity(itemId, 11)).body.error).toBe("Solo quedan 10 unidades de Doble cheddar.");
      expect((await setQuantity(itemId, 5)).body.error).toBe("Solo quedan 4 de Panceta.");
    });

    it("un item de otra conversación no se toca", async () => {
      const added = await addItems([{ productId: s.sodaId, quantity: 1 }]);
      const otra = await ownerDb().whatsappConversation.create({ data: { businessId: s.businessId, contactId: "wa-otra" } });
      const res = await request(app)
        .patch(`/v1/agent/draft/items/${added.body.pedido.items[0].id}`)
        .set(key)
        .send({ businessId: s.businessId, conversationId: otra.id, quantity: 5 })
        .expect(200);
      expect(res.body).toEqual({ ok: false, error: "Ese item ya no esta en el pedido." });
    });

    it("pasar a retiro borra la dirección", async () => {
      await addItems([{ productId: s.sodaId, quantity: 1 }]);
      await request(app)
        .patch("/v1/agent/draft")
        .set(key)
        .send({ ...ids(), orderType: "delivery", deliveryAddress: "Laprida 450" })
        .expect(200);
      const res = await request(app).patch("/v1/agent/draft").set(key).send({ ...ids(), orderType: "takeaway" }).expect(200);
      expect(res.body.pedido.order_type).toBe("takeaway");
      expect(res.body.pedido.delivery_address).toBeNull();
    });
  });

  describe("V2: confirmar", () => {
    const ids = () => ({ businessId: s.businessId, conversationId });

    async function armar(paymentMethod: "cash" | "transfer" = "cash") {
      await request(app)
        .post("/v1/agent/draft/items")
        .set(key)
        .send({ ...ids(), items: [{ productId: s.sodaId, quantity: 1 }] })
        .expect(200);
      await request(app)
        .patch("/v1/agent/draft")
        .set(key)
        .send({ ...ids(), customerName: "Ana", orderType: "takeaway", paymentMethod })
        .expect(200);
    }

    const confirm = () => request(app).post("/v1/agent/draft/confirm").set(key).send(ids());

    it("con el local abierto devuelve código, hora estimada y seguimiento", async () => {
      await armar();
      const res = await confirm().expect(201);
      expect(res.body).toMatchObject({ ok: true, para_la_apertura: false, abre: null });
      expect(res.body.eta).toMatch(/^\d{2}:\d{2}$/);
      expect(res.body.track_url).toContain(`/${s.slug}/order/${res.body.orderCode}`);
      expect(res.body).not.toHaveProperty("transferencia");
    });

    it("si paga por transferencia devuelve los datos para transferir", async () => {
      await ownerDb().paymentSettings.update({
        where: { businessId: s.businessId },
        data: { transferAlias: "la.esquina.mp", transferHolder: "Juan Pérez" }
      });
      await armar("transfer");
      const res = await confirm().expect(201);
      expect(res.body.transferencia).toMatchObject({ alias: "la.esquina.mp", titular: "Juan Pérez" });
    });

    it("con el local cerrado toma el pedido y lo deja para la apertura", async () => {
      await closedUntilTomorrowAt10();
      await armar();
      const res = await confirm().expect(201);
      // 10:00 + 45 min de demora (valor por defecto del negocio).
      expect(res.body).toMatchObject({ ok: true, para_la_apertura: true, abre: "mañana a las 10:00", eta: "10:45" });

      const order = await ownerDb().order.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(order.status).toBe("pending");
      const history = await ownerDb().orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history).toHaveLength(1);
      expect(history[0]!.note).toMatch(/local cerrado/);

      // El contexto cuenta la misma hora estimada, no una calculada desde ahora.
      expect((await context()).active_order.eta).toBe("10:45");
    });

    it("cerrado sin horarios en los próximos días no toma el pedido", async () => {
      await closedUntilTomorrowAt10({ opensTomorrow: false });
      await armar();
      const res = await confirm().expect(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/no tiene horarios/);
    });
  });
});
