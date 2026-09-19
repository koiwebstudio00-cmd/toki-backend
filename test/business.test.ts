import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disconnectDb } from "../src/lib/db.js";
import { publicUrl } from "../src/lib/r2.js";
import { bearer, createUser, DB_AVAILABLE, ownerDb, seedTeam, truncateAll } from "./helpers.js";

const app = buildApp();

describe.runIf(DB_AVAILABLE)("businesses", () => {
  let t: Awaited<ReturnType<typeof seedTeam>>;

  beforeAll(async () => {
    t = await seedTeam();
  });

  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  describe("onboarding", () => {
    it("crea negocio con owner, bot, horarios y medios de pago", async () => {
      const u = await createUser("nuevo@toki.test");
      const res = await request(app)
        .post("/v1/businesses")
        .set(bearer(u))
        .send({ name: "Lomitos Tito", slug: "Lomitos-Tito", phone: "3815551111", city: "Tucumán", address: "", description: "Los mejores" });
      expect(res.status).toBe(201);
      expect(res.body.slug).toBe("lomitos-tito");

      const b = await ownerDb().business.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { businessMembers: true, botSettings: true, businessHours: true, paymentSettings: true }
      });
      expect(b.whatsappPhone).toBe("3815551111");
      expect(b.address).toBeNull();
      expect(b.businessMembers).toEqual([expect.objectContaining({ userId: u.id, role: "owner" })]);
      expect(b.botSettings).not.toBeNull();
      expect(b.businessHours).toHaveLength(7);
      expect(b.paymentSettings).toMatchObject({ cashEnabled: true, transferEnabled: true });

      const me = await request(app).get("/v1/auth/me").set(bearer(u));
      expect(me.body.currentBusiness).toMatchObject({ id: res.body.id, role: "owner" });
    });

    it("409 con slug en uso y 400 con slug reservado o inválido", async () => {
      const u = await createUser("slug@toki.test");
      expect((await request(app).post("/v1/businesses").set(bearer(u)).send({ name: "Otro", slug: "team-a" })).status).toBe(409);
      expect((await request(app).post("/v1/businesses").set(bearer(u)).send({ name: "Otro", slug: "dashboard" })).status).toBe(400);
      expect((await request(app).post("/v1/businesses").set(bearer(u)).send({ name: "Otro", slug: "con espacios" })).status).toBe(400);
    });

    it("exige sesión", async () => {
      expect((await request(app).post("/v1/businesses").send({ name: "X", slug: "xxx" })).status).toBe(401);
    });
  });

  describe("negocio actual", () => {
    it("GET devuelve el negocio con montos numéricos e isOpen", async () => {
      const res = await request(app).get("/v1/business").set(bearer(t.staff));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: t.businessId, slug: "team-a", deliveryFee: 0, minimumOrderAmount: 0, manualStatus: "auto" });
      expect(typeof res.body.isOpen).toBe("boolean");
    });

    it("admin edita; staff no", async () => {
      const ok = await request(app)
        .patch("/v1/business")
        .set(bearer(t.admin))
        .send({ name: "Team A Renovado", deliveryFee: 1500.5, minimumOrderAmount: "8000", description: "" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: "Team A Renovado", deliveryFee: 1500.5, minimumOrderAmount: 8000, description: null });

      expect((await request(app).patch("/v1/business").set(bearer(t.staff)).send({ name: "Nope" })).status).toBe(403);
    });

    it("solo acepta imágenes propias o defaults", async () => {
      const own = publicUrl(`${t.businessId}/business/logo/abc.webp`);
      expect((await request(app).patch("/v1/business").set(bearer(t.owner)).send({ logoUrl: own })).status).toBe(200);
      expect((await request(app).patch("/v1/business").set(bearer(t.owner)).send({ coverUrl: "/defaults/toki-default-banner.png" })).status).toBe(200);

      const foreign = publicUrl(`${t.otherBusinessId}/business/logo/abc.webp`);
      expect((await request(app).patch("/v1/business").set(bearer(t.owner)).send({ logoUrl: foreign })).status).toBe(400);
      expect((await request(app).patch("/v1/business").set(bearer(t.owner)).send({ logoUrl: "https://evil.test/x.png" })).status).toBe(400);
    });

    it("cambiar el slug a uno ocupado da 409", async () => {
      expect((await request(app).patch("/v1/business").set(bearer(t.owner)).send({ slug: "team-b" })).status).toBe(409);
    });

    it("estado manual: closed → isOpen false; open → true", async () => {
      const closed = await request(app).patch("/v1/business/status").set(bearer(t.owner)).send({ manualStatus: "closed" });
      expect(closed.body).toEqual({ manualStatus: "closed", isOpen: false });
      const open = await request(app).patch("/v1/business/status").set(bearer(t.owner)).send({ manualStatus: "open" });
      expect(open.body).toEqual({ manualStatus: "open", isOpen: true });
      expect((await request(app).patch("/v1/business/status").set(bearer(t.staff)).send({ manualStatus: "auto" })).status).toBe(403);
    });

    it("X-Business-Id elige entre negocios del usuario y no deja operar sobre ajenos", async () => {
      const res = await request(app).patch("/v1/business").set(bearer(t.owner)).set("x-business-id", t.otherBusinessId).send({ name: "hack" });
      expect(res.status).toBe(403);
      const other = await ownerDb().business.findUniqueOrThrow({ where: { id: t.otherBusinessId } });
      expect(other.name).not.toBe("hack");
    });
  });

  describe("horarios", () => {
    const week = (overrides: Record<number, object> = {}) =>
      Array.from({ length: 7 }, (_, day) => ({
        dayOfWeek: day,
        isOpen: day !== 1,
        opensAt: "11:30",
        closesAt: "15:00",
        opensAt2: "19:30",
        closesAt2: "00:30",
        ...overrides[day]
      }));

    it("reemplaza la semana y devuelve HH:mm; los días cerrados quedan sin horas", async () => {
      const res = await request(app).put("/v1/business/hours").set(bearer(t.admin)).send({ hours: week() });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(7);
      expect(res.body.data[0]).toEqual({ dayOfWeek: 0, isOpen: true, opensAt: "11:30", closesAt: "15:00", opensAt2: "19:30", closesAt2: "00:30" });
      expect(res.body.data[1]).toEqual({ dayOfWeek: 1, isOpen: false, opensAt: null, closesAt: null, opensAt2: null, closesAt2: null });

      const get = await request(app).get("/v1/business/hours").set(bearer(t.staff));
      expect(get.body.data).toEqual(res.body.data);
    });

    it("valida la semana", async () => {
      const cases = [
        { hours: week().slice(0, 6) },
        { hours: week({ 3: { dayOfWeek: 2 } }) },
        { hours: week({ 2: { opensAt: null } }) },
        { hours: week({ 2: { closesAt2: null } }) },
        { hours: week({ 2: { opensAt2: "14:00" } }) },
        { hours: week({ 2: { opensAt: "25:00" } }) }
      ];
      for (const body of cases) {
        expect((await request(app).put("/v1/business/hours").set(bearer(t.owner)).send(body)).status).toBe(400);
      }
      expect((await request(app).put("/v1/business/hours").set(bearer(t.staff)).send({ hours: week() })).status).toBe(403);
    });

    it("horarios especiales: reemplazo, filtro por fecha y borrado", async () => {
      const put = await request(app)
        .put("/v1/business/special-hours")
        .set(bearer(t.owner))
        .send({
          specialHours: [
            { date: "2026-12-25", isClosed: true, note: "Navidad" },
            { date: "2026-12-31", isClosed: false, opensAt: "10:00", closesAt: "16:00", opensAtIgnorado: 1 },
            { date: "2020-01-01", isClosed: true }
          ]
        });
      expect(put.status).toBe(200);
      expect(put.body.data.map((h: { date: string }) => h.date)).toEqual(["2020-01-01", "2026-12-25", "2026-12-31"]);
      expect(put.body.data[2]).toMatchObject({ isClosed: false, opensAt: "10:00", closesAt: "16:00", note: null });

      const future = await request(app).get("/v1/business/special-hours?from=2026-01-01").set(bearer(t.staff));
      expect(future.body.data).toHaveLength(2);

      const id = put.body.data[0].id;
      await request(app).delete(`/v1/business/special-hours/${id}`).set(bearer(t.owner)).expect(204);
      expect((await request(app).delete(`/v1/business/special-hours/${id}`).set(bearer(t.owner))).status).toBe(404);

      const dup = await request(app).put("/v1/business/special-hours").set(bearer(t.owner)).send({
        specialHours: [{ date: "2026-05-01", isClosed: true }, { date: "2026-05-01", isClosed: true }]
      });
      expect(dup.status).toBe(400);
      const open = await request(app).put("/v1/business/special-hours").set(bearer(t.owner)).send({
        specialHours: [{ date: "2026-05-01", isClosed: false }]
      });
      expect(open.status).toBe(400);
    });

    it("un horario especial cerrado hoy cierra el negocio en modo auto", async () => {
      await request(app).patch("/v1/business/status").set(bearer(t.owner)).send({ manualStatus: "auto" }).expect(200);
      // Semana sin cierres después de medianoche: si el día anterior cerrara a
      // las 00:30, entre las 00:00 y las 00:30 el negocio sigue abierto por la
      // ventana de ayer, y el test dependería de la hora a la que se corre.
      await request(app)
        .put("/v1/business/hours")
        .set(bearer(t.owner))
        .send({ hours: week({}) .map((day) => ({ ...day, opensAt2: null, closesAt2: null })) })
        .expect(200);
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
      await request(app).put("/v1/business/special-hours").set(bearer(t.owner)).send({ specialHours: [{ date: today, isClosed: true }] }).expect(200);
      const res = await request(app).get("/v1/business").set(bearer(t.owner));
      expect(res.body.isOpen).toBe(false);
    });

    it("la ventana de ayer que cruza la medianoche mantiene abierto el negocio", async () => {
      await request(app).patch("/v1/business/status").set(bearer(t.owner)).send({ manualStatus: "auto" }).expect(200);
      // Abierto todos los días de 19:30 a 00:30: a las 00:10 de hoy, el negocio
      // sigue en el turno de ayer.
      await request(app)
        .put("/v1/business/hours")
        .set(bearer(t.owner))
        .send({
          hours: Array.from({ length: 7 }, (_, day) => ({
            dayOfWeek: day,
            isOpen: true,
            opensAt: "19:30",
            closesAt: "23:00",
            opensAt2: "23:30",
            closesAt2: "00:30"
          }))
        })
        .expect(200);
      await request(app).put("/v1/business/special-hours").set(bearer(t.owner)).send({ specialHours: [] }).expect(200);

      const localHour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false }).format(new Date())
      );
      const localMinutes = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", minute: "2-digit" }).format(new Date())
      );
      const dentroDelTurno =
        (localHour === 19 && localMinutes >= 30) || (localHour > 19 && localHour <= 23) || (localHour === 0 && localMinutes <= 30);

      const res = await request(app).get("/v1/business").set(bearer(t.owner));
      expect(res.body.isOpen).toBe(dentroDelTurno);
    });
  });

  describe("checklist", () => {
    it("refleja el estado de configuración", async () => {
      await truncateAll();
      t = await seedTeam();
      const res = await request(app).get("/v1/business/checklist").set(bearer(t.staff));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        slug: "team-a",
        hasLogo: false,
        hasCover: false,
        hasHours: true,
        hasCategories: false,
        hasProducts: false,
        whatsappConnected: false,
        completed: false
      });
    });
  });
});
