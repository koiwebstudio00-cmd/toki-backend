import { config } from "../config.js";
import { disconnectDb } from "../lib/db.js";
import { createAdminActivation } from "../modules/admin/activation.js";
try {
  if (!config.SUPERADMIN_EMAIL) throw new Error("Configurá SUPERADMIN_EMAIL con el email de la cuenta administrativa.");
  const activation = await createAdminActivation(config.SUPERADMIN_EMAIL, process.argv.includes("--reset"));
  console.log("Abrí este enlace privado para elegir la contraseña y escanear el QR del autenticador. Vence en 30 minutos:");
  console.log(activation.url);
} finally { await disconnectDb(); }
