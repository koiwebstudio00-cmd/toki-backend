import bcrypt from "bcrypt";

// Costo 12. Los hashes migrados de Supabase Auth ($2a$10$...) siguen validando.
const ROUNDS = 12;

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
