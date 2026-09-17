import type { BusinessRole } from "../middleware/business.js";

declare global {
  namespace Express {
    interface Request {
      /** Usuario autenticado (requireAuth). */
      auth?: { userId: string; email: string };
      /** Negocio actual y rol del usuario en él (requireBusiness). */
      business?: { id: string; role: BusinessRole };
      /** true si el request vino con la API key del agente (requireApiKey). */
      agent?: boolean;
    }
  }
}

export {};
