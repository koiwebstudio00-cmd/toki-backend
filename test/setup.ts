// Corre antes de cada archivo de test (vitest setupFiles), ANTES de importar config.
// La app bajo test se conecta como toki_test_app, con los mismos contextos que producción, para que
// RLS aplique de verdad. Los datos de prueba se preparan con el rol dueño.
import "dotenv/config";
import { testDatabaseConfig } from "../scripts/lib/test-database.js";

const testDatabase = process.env.DATABASE_URL_TEST ? testDatabaseConfig(process.env) : null;

process.env.NODE_ENV = "test";
// Nunca heredar las credenciales reales ni activar el worker en una prueba automática.
process.env.OPENAI_API_KEY = "";
process.env.OPENAI_MODEL = "";
process.env.AI_GATEWAY_API_KEY = "";
process.env.AI_GATEWAY_MODEL = "";
process.env.AGENT_WORKER_ENABLED = "false";
process.env.MP_INTEGRATION_ENABLED = "false";
process.env.MP_QR_ENABLED = "false";
process.env.MP_WEBHOOK_SECRET = "";
process.env.MP_CLIENT_ID = "";
process.env.MP_CLIENT_SECRET = "";
process.env.MP_TOKEN_ENCRYPTION_KEY = "";
process.env.MP_REDIRECT_URI = "";
process.env.MP_ENVIRONMENT = "test";

if (testDatabase) {
  process.env.DATABASE_URL = testDatabase.runtimeUrl;
  process.env.DATABASE_URL_LISTEN = testDatabase.runtimeUrl;
} else {
  // Sin BD de test: los tests de integración se saltean (describe.runIf).
  process.env.DATABASE_URL = "postgresql://toki_test_app:x@127.0.0.1:1/none";
  process.env.DATABASE_URL_LISTEN = process.env.DATABASE_URL;
}

// Key del agente conocida para los tests: sha256("test-agent-key").
process.env.AGENT_API_KEY_SHA256 = "4d25b7920b389a66f0c2f265b145519aa821b431e96eaa7d2927b8e9ef275cdb";
process.env.ZERNIO_API_KEY = "test-zernio-api-key";
