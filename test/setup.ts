// Corre antes de cada archivo de test (vitest setupFiles), ANTES de importar config.
// La app bajo test se conecta como toki_app, igual que en producción, para que
// RLS aplique de verdad. Los datos de prueba se preparan con el rol dueño.
import "dotenv/config";

process.env.NODE_ENV = "test";

if (process.env.DATABASE_URL_TEST) {
  const url = new URL(process.env.DATABASE_URL_TEST);
  url.username = "toki_app";
  url.password = "toki_app_test"; // la fija scripts/migrate-test.ts
  process.env.DATABASE_URL = url.toString();
} else {
  // Sin BD de test: los tests de integración se saltean (describe.runIf).
  process.env.DATABASE_URL ??= "postgresql://toki_app:x@127.0.0.1:1/none";
}

// Key del agente conocida para los tests: sha256("test-agent-key").
process.env.AGENT_API_KEY_SHA256 = "4d25b7920b389a66f0c2f265b145519aa821b431e96eaa7d2927b8e9ef275cdb";
process.env.ZERNIO_API_KEY = "test-zernio-api-key";
