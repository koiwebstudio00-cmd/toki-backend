// Utilidades de test. `ownerDb` usa el rol dueño y bypassa RLS a propósito, solo
// para preparar y limpiar datos. Lo que se prueba corre siempre por withDb.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type business_role } from "@prisma/client";
import bcrypt from "bcrypt";
import { withDb } from "../src/lib/db.js";
import { signAccessToken } from "../src/lib/tokens.js";

export const DB_AVAILABLE = Boolean(process.env.DATABASE_URL_TEST);
export const TEST_PASSWORD = "password123";
export const TEST_AGENT_KEY = "test-agent-key";

let _owner: PrismaClient | null = null;

export function ownerDb(): PrismaClient {
  _owner ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL_TEST!, max: 2 })
  });
  return _owner;
}

/** Vacía todas las tablas de negocio y de auth. */
export async function truncateAll(): Promise<void> {
  await ownerDb().$executeRawUnsafe(
    `truncate auth.users, auth.refresh_tokens, auth.email_tokens, public.businesses restart identity cascade`
  );
}

let _hash: string | null = null;

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function createUser(email: string, opts: { verified?: boolean; fullName?: string } = {}): Promise<TestUser> {
  _hash ??= await bcrypt.hash(TEST_PASSWORD, 4);
  const user = await ownerDb().user.create({
    data: {
      email,
      passwordHash: _hash,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      rawUserMetaData: { full_name: opts.fullName ?? email.split("@")[0] }
    }
  });
  return { id: user.id, email: user.email, token: signAccessToken({ userId: user.id, email: user.email }) };
}

/** Crea el negocio con la función SQL real, como owner (contexto authenticated). */
export async function createBusiness(owner: TestUser, slug: string): Promise<string> {
  const rows = await withDb({ role: "authenticated", userId: owner.id, email: owner.email }, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      select public.create_business_with_owner(${`Negocio ${slug}`}, ${slug}, null, null, 'Tucumán', null) as id`
  );
  return rows[0]!.id;
}

export async function addMember(businessId: string, user: TestUser, role: business_role): Promise<void> {
  await ownerDb().businessMember.create({ data: { businessId, userId: user.id, role } });
}

/** Dos negocios con owner y un staff cada uno. */
export async function seedTwoBusinesses() {
  await truncateAll();
  const ownerA = await createUser("owner@a.test");
  const staffA = await createUser("staff@a.test");
  const ownerB = await createUser("owner@b.test");
  const businessA = await createBusiness(ownerA, "negocio-a");
  const businessB = await createBusiness(ownerB, "negocio-b");
  await addMember(businessA, staffA, "staff");

  const categoryB = await ownerDb().category.create({ data: { businessId: businessB, name: "Burgers B" } });
  await ownerDb().category.create({ data: { businessId: businessA, name: "Pizzas A" } });

  await ownerDb().order.create({
    data: {
      businessId: businessB,
      orderCode: "TK-100001",
      orderType: "takeaway",
      customerName: "Cliente B",
      customerPhone: "3815550000",
      subtotal: 1000,
      total: 1000
    }
  });

  return { ownerA, staffA, ownerB, businessA, businessB, categoryB: categoryB.id };
}

export const authCtx = (u: TestUser) => ({ role: "authenticated" as const, userId: u.id, email: u.email });

/** Negocio A con owner, admin y staff; negocio B con su owner. Para tests por HTTP. */
export async function seedTeam() {
  await truncateAll();
  const owner = await createUser("owner@team.test");
  const admin = await createUser("admin@team.test");
  const staff = await createUser("staff@team.test");
  const other = await createUser("owner@otro.test");
  const businessId = await createBusiness(owner, "team-a");
  const otherBusinessId = await createBusiness(other, "team-b");
  await addMember(businessId, admin, "admin");
  await addMember(businessId, staff, "staff");
  return { owner, admin, staff, other, businessId, otherBusinessId };
}

export const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

/**
 * Negocio listo para vender: abierto, con efectivo y transferencia, una
 * hamburguesa con opciones (una obligatoria y una con recargo) y una gaseosa.
 * Es la base de los tests de checkout, pedidos y dashboard.
 */
export async function seedShop(slug = "shop-test") {
  await truncateAll();
  const owner = await createUser(`owner@${slug}.test`);
  const staff = await createUser(`staff@${slug}.test`);
  const businessId = await createBusiness(owner, slug);
  await addMember(businessId, staff, "staff");

  const db = ownerDb();
  // manual_status = open: el test no depende de la hora a la que se corre.
  await db.business.update({
    where: { id: businessId },
    data: { manualStatus: "open", minimumOrderAmount: 1000, deliveryFee: 500, city: "Tucumán" }
  });
  await db.paymentSettings.upsert({
    where: { businessId },
    create: { businessId, cashEnabled: true, transferEnabled: true },
    update: { cashEnabled: true, transferEnabled: true }
  });

  const category = await db.category.create({ data: { businessId, name: "Hamburguesas", sortOrder: 1 } });

  const burger = await db.product.create({
    data: {
      businessId,
      categoryId: category.id,
      name: "Doble cheddar",
      price: 10000,
      trackStock: true,
      stockQuantity: 10,
      sortOrder: 1
    }
  });
  const punto = await db.productOption.create({
    data: { businessId, productId: burger.id, name: "Punto", type: "single", isRequired: true, minSelect: 1, maxSelect: 1 }
  });
  const aPunto = await db.productOptionValue.create({
    data: { businessId, optionId: punto.id, name: "A punto", sortOrder: 1 }
  });
  const jugosa = await db.productOptionValue.create({
    data: { businessId, optionId: punto.id, name: "Jugosa", sortOrder: 2 }
  });
  const extras = await db.productOption.create({
    data: { businessId, productId: burger.id, name: "Extras", type: "multiple", isRequired: false, minSelect: 0, maxSelect: 2 }
  });
  const panceta = await db.productOptionValue.create({
    data: { businessId, optionId: extras.id, name: "Panceta", priceDelta: 1500, trackStock: true, stockQuantity: 4, sortOrder: 1 }
  });

  const soda = await db.product.create({
    data: { businessId, categoryId: category.id, name: "Gaseosa", price: 2500, sortOrder: 2 }
  });

  return {
    owner,
    staff,
    businessId,
    categoryId: category.id,
    burgerId: burger.id,
    sodaId: soda.id,
    puntoId: punto.id,
    aPuntoId: aPunto.id,
    jugosaId: jugosa.id,
    extrasId: extras.id,
    pancetaId: panceta.id,
    slug
  };
}

export async function createCoupon(
  businessId: string,
  code: string,
  data: Partial<{
    discountType: string;
    discountValue: number;
    minimumOrderAmount: number;
    usageLimit: number | null;
    usedCount: number;
    isActive: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
  }> = {}
) {
  return ownerDb().coupon.create({
    data: {
      businessId,
      code,
      discountType: data.discountType ?? "percent",
      discountValue: data.discountValue ?? 10,
      minimumOrderAmount: data.minimumOrderAmount ?? 0,
      usageLimit: data.usageLimit ?? null,
      usedCount: data.usedCount ?? 0,
      isActive: data.isActive ?? true,
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null
    }
  });
}
