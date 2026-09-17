// Datos de desarrollo: 2 negocios con owner y catálogo mínimo. Uso: npm run seed
// Usa el mismo camino que la API (withDb + funciones SQL) para que el seed
// también valide que la BD local quedó bien migrada. Idempotente por email/slug.
import "dotenv/config";
import { disconnectDb, withDb } from "../src/lib/db.js";
import { hashPassword } from "../src/lib/passwords.js";

if (process.env.NODE_ENV === "production") throw new Error("El seed no se corre en producción.");

const PASSWORD = "toki12345";

const BUSINESSES = [
  { email: "owner@burger.test", name: "Toki Demo Burger", slug: "toki-demo", category: "Hamburguesas", product: "Clásica", price: 8500 },
  { email: "owner@pizza.test", name: "Pizzería Demo", slug: "pizzeria-demo", category: "Pizzas", product: "Muzzarella", price: 9800 }
];

const passwordHash = await hashPassword(PASSWORD);

for (const b of BUSINESSES) {
  const user = await withDb({ role: "service_role" }, async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: b.email } });
    return (
      existing ??
      tx.user.create({
        data: { email: b.email, passwordHash, emailVerifiedAt: new Date(), rawUserMetaData: { full_name: `Owner ${b.name}` } }
      })
    );
  });

  const ctx = { role: "authenticated" as const, userId: user.id, email: user.email };

  await withDb(ctx, async (tx) => {
    const exists = await tx.business.findUnique({ where: { slug: b.slug } });
    if (exists) {
      console.log(`[seed] ${b.slug} ya existe, se saltea.`);
      return;
    }
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      select public.create_business_with_owner(${b.name}, ${b.slug}, '3815550000', 'Av. Mate de Luna 1234', 'San Miguel de Tucumán', null) as id`;
    const businessId = row!.id;

    await tx.paymentSettings.create({
      data: { businessId, cashEnabled: true, transferEnabled: true, transferAlias: `${b.slug}.mp`, transferHolder: b.name }
    });
    const category = await tx.category.create({ data: { businessId, name: b.category, sortOrder: 1 } });
    await tx.product.create({
      data: {
        businessId,
        categoryId: category.id,
        name: b.product,
        price: b.price,
        stockQuantity: 50,
        isFeatured: true,
        options: {
          create: {
            businessId,
            name: "Extras",
            type: "multiple",
            minSelect: 0,
            maxSelect: 3,
            values: { create: [{ businessId, name: "Cheddar", priceDelta: 900, stockQuantity: 100 }] }
          }
        }
      }
    });
    console.log(`[seed] ${b.slug} creado (owner ${b.email} / ${PASSWORD}).`);
  });
}

await disconnectDb();
