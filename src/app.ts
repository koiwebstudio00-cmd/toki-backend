import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config, corsOrigins } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestLogger } from "./middleware/logging.js";
import { healthRoutes } from "./modules/health/routes.js";

export function buildApp() {
  const app = express();

  app.disable("x-powered-by");
  // Detrás de Traefik (Dokploy): confiar solo en el primer hop para la IP real.
  app.set("trust proxy", 1);
  // Primero de todo: queda registrada también la request que rebota por CORS o tamaño.
  app.use(requestLogger());
  app.use(helmet());
  // Bearer tokens, sin cookies: no hace falta credentials. En producción, allowlist.
  app.use(
    cors({
      origin: corsOrigins.length > 0 ? corsOrigins : config.NODE_ENV !== "production",
      allowedHeaders: ["Authorization", "Content-Type", "X-Business-Id"],
      maxAge: 600
    })
  );
  app.use(express.json({ limit: "1mb" }));

  const v1 = express.Router();
  v1.use(healthRoutes);
  // Módulos de F1 en adelante: auth, account, businesses, settings, coupons,
  // catalog, uploads, orders, customers, dashboard, whatsapp, public, agent.
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
