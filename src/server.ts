import { startAgentWorker } from "./modules/agent/worker.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { disconnectDb } from "./lib/db.js";
import { stopListening } from "./lib/realtime.js";

const app = buildApp();
const stopAgentWorker = startAgentWorker();

const server = app.listen(config.PORT, () => {
  console.log(`toki-api escuchando en http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

// Cierre limpio: Dokploy manda SIGTERM en cada deploy.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} recibido, cerrando...`);
  server.close(async () => {
    await stopAgentWorker();
    await stopListening();
    await disconnectDb();
    process.exit(0);
  });
  // Si hay conexiones colgadas (SSE), no esperar para siempre.
  setTimeout(() => process.exit(0), 60_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
