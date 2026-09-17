import bcrypt from "bcrypt";
import { config } from "../config.js";

// Costo 12. Los hashes migrados de Supabase Auth ($2a$10$...) siguen validando.
// En tests, costo 4: bcrypt 12 hace que la suite de auth tarde ~10 s de más.
const ROUNDS = config.NODE_ENV === "test" ? 4 : 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // Hash inválido o placeholder: nunca matchea.
    return false;
  }
}
