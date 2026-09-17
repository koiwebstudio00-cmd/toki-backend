import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config, corsOrigins } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestLogger } from "./middleware/logging.js";
import { accountRoutes } from "./modules/account/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { businessRoutes, onboardingRoutes } from "./modules/businesses/routes.js";
import { categoryRoutes, ingredientRoutes, productRoutes } from "./modules/catalog/routes.js";
import { couponRoutes } from "./modules/coupons/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { uploadRoutes } from "./modules/uploads/routes.js";

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
  v1.use(authRoutes);
  v1.use(accountRoutes);
  // Routers de negocio montados con prefijo: sus middlewares (auth + negocio)
  // solo aplican a sus rutas, nunca a /public ni /agent.
  v1.use("/businesses", onboardingRoutes);
  v1.use("/business", businessRoutes);
  v1.use("/settings", settingsRoutes);
  v1.use("/coupons", couponRoutes);
  v1.use("/categories", categoryRoutes);
  v1.use("/products", productRoutes);
  v1.use("/ingredients", ingredientRoutes);
  v1.use("/uploads", uploadRoutes);
  // Próximas fases: orders, customers, dashboard, whatsapp, public, agent.
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
