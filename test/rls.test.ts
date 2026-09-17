// Aislamiento multi-tenant: docs/base-de-datos.md §6 y docs/arquitectura.md §5.
// Todo corre por withDb con la conexión toki_app, igual que en producción.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDb, getPrisma, withDb } from "../src/lib/db.js";
import { mapDbError } from "../src/middleware/error.js";
import { authCtx, DB_AVAILABLE, ownerDb, seedTwoBusinesses } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("RLS y contextos de BD", () => {
  let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;

  beforeAll(async () => {
    s = await seedTwoBusinesses();
  });

  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  it("sin contexto, toki_app no puede leer tablas", async () => {
    await expect(getPrisma().order.count()).rejects.toThrow(/permission denied/i);
  });

  it("auth.uid() devuelve el usuario del contexto", async () => {
    const rows = await withDb(authCtx(s.ownerA), (tx) =>
      tx.$queryRaw<{ uid: string; role: string }[]>`select auth.uid()::text as uid, current_user::text as role`
    );
    expect(rows[0]).toEqual({ uid: s.ownerA.id, role: "authenticated" });
  });

  it("el contexto no se filtra a la transacción siguiente", async () => {
    await withDb(authCtx(s.ownerA), (tx) => tx.botSettings.count());
    const rows = await getPrisma().$queryRaw<{ role: string; claims: string | null }[]>`
      select current_user::text as role, nullif(current_setting('request.jwt.claims', true), '') as claims`;
    expect(rows[0]).toEqual({ role: "toki_app", claims: null });
  });

  it("create_business_with_owner creó negocio, owner, bot y horarios", async () => {
    const [members, bot, hours] = await Promise.all([
      ownerDb().businessMember.findMany({ where: { businessId: s.businessA } }),
      ownerDb().botSettings.count({ where: { businessId: s.businessA } }),
      ownerDb().businessHour.count({ where: { businessId: s.businessA } })
    ]);
    expect(members.find((m) => m.userId === s.ownerA.id)?.role).toBe("owner");
    expect(bot).toBe(1);
    expect(hours).toBe(7);
  });

  it("un owner no ve pedidos de otro negocio; el owner dueño sí", async () => {
    expect(await withDb(authCtx(s.ownerA), (tx) => tx.order.count())).toBe(0);
    expect(await withDb(authCtx(s.ownerB), (tx) => tx.order.count())).toBe(1);
  });

  it("un owner solo ve datos privados de su negocio", async () => {
    const bots = await withDb(authCtx(s.ownerA), (tx) => tx.botSettings.findMany());
    expect(bots.map((b) => b.businessId)).toEqual([s.businessA]);

    const members = await withDb(authCtx(s.ownerA), (tx) => tx.businessMember.findMany());
    expect(members.every((m) => m.businessId === s.businessA)).toBe(true);
  });

  it("no puede modificar datos de otro negocio (0 filas, sin error)", async () => {
    const res = await withDb(authCtx(s.ownerA), (tx) =>
      tx.category.updateMany({ where: { id: s.categoryB }, data: { name: "hackeada" } })
    );
    expect(res.count).toBe(0);
    const cat = await ownerDb().category.findUnique({ where: { id: s.categoryB } });
    expect(cat?.name).toBe("Burgers B");
  });

  it("no puede insertar en otro negocio", async () => {
    const err = await withDb(authCtx(s.ownerA), (tx) =>
      tx.category.create({ data: { businessId: s.businessB, name: "intrusa" } })
    ).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("FORBIDDEN");
  });

  it("staff lee el catálogo pero no puede editarlo", async () => {
    const cats = await withDb(authCtx(s.staffA), (tx) => tx.category.findMany({ where: { businessId: s.businessA } }));
    expect(cats.length).toBe(1);

    const err = await withDb(authCtx(s.staffA), (tx) =>
      tx.category.create({ data: { businessId: s.businessA, name: "no autorizada" } })
    ).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("FORBIDDEN");
  });

  it("anon ve negocios activos y catálogo, pero no pedidos ni auth", async () => {
    const businesses = await withDb({ role: "anon" }, (tx) => tx.business.count());
    expect(businesses).toBe(2);
    const categories = await withDb({ role: "anon" }, (tx) => tx.category.count());
    expect(categories).toBe(2);
    // anon tiene GRANT sobre la tabla (herencia de Supabase), pero RLS no le devuelve filas.
    expect(await ownerDb().order.count()).toBe(1);
    expect(await withDb({ role: "anon" }, (tx) => tx.order.count())).toBe(0);
    await expect(withDb({ role: "anon" }, (tx) => tx.user.count())).rejects.toThrow(/permission denied/i);
  });

  it("authenticated no accede a las tablas de auth", async () => {
    await expect(withDb(authCtx(s.ownerA), (tx) => tx.user.count())).rejects.toThrow(/permission denied/i);
  });

  it("service_role ve todos los negocios y auth", async () => {
    const [bots, users] = await withDb({ role: "service_role" }, (tx) =>
      Promise.all([tx.botSettings.count(), tx.user.count()])
    );
    expect(bots).toBe(2);
    expect(users).toBe(3);
  });

  it("los errores de funciones SQL llegan como 400 con el mensaje original", async () => {
    const err = await withDb(authCtx(s.ownerA), (tx) =>
      tx.$queryRaw`select public.create_manual_sale(${JSON.stringify({ businessId: s.businessA, items: [] })}::jsonb)`
    ).catch((e: unknown) => e);
    const mapped = mapDbError(err);
    expect(mapped?.code).toBe("VALIDATION_ERROR");
    expect(mapped?.message).toBe("La venta no tiene productos");
  });

  it("update_order_status rechaza pedidos de otro negocio", async () => {
    const err = await withDb(authCtx(s.ownerA), (tx) =>
      tx.$queryRaw`select public.update_order_status(gen_random_uuid(), 'confirmed'::public.order_status, null)`
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});

describe.runIf(DB_AVAILABLE)("mapDbError", () => {
  afterAll(async () => {
    await disconnectDb();
    await ownerDb().$disconnect();
  });

  it("slug duplicado → 409", async () => {
    const err = await withDb({ role: "service_role" }, (tx) =>
      tx.business.create({ data: { name: "Dup", slug: "negocio-a" } })
    ).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("CONFLICT");
  });

  it("CHECK violado → 400", async () => {
    const err = await withDb({ role: "service_role" }, (tx) =>
      tx.business.create({ data: { name: "Mal", slug: "Slug Con Espacios" } })
    ).catch((e: unknown) => e);
    expect(mapDbError(err)?.code).toBe("VALIDATION_ERROR");
  });
});
