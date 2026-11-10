import { config } from "../config.js";
import { disconnectDb, systemCtx, withDb } from "../lib/db.js";
import { createInvitation } from "../modules/auth/invitations.js";

try {
  if (!config.SUPERADMIN_EMAIL) throw new Error("Configurá SUPERADMIN_EMAIL antes de ejecutar este comando.");
  const email = config.SUPERADMIN_EMAIL;
  const user = await withDb(systemCtx, tx => tx.user.findUnique({
    where: { email }, select: { id: true, emailVerifiedAt: true }
  }));
  if (!user) {
    const invite = await createInvitation(email, null);
    const url = new URL("/acceso/invitacion", config.FRONT_URL);
    url.hash = new URLSearchParams({ codigo: invite.code }).toString();
    console.log(url.href);
  } else if (user.emailVerifiedAt) {
    console.log(`SUPERADMIN_USER_IDS=${user.id}`);
  } else {
    console.log("La cuenta existe. Confirmá el email y volvé a ejecutar el comando.");
  }
} finally {
  await disconnectDb();
}
