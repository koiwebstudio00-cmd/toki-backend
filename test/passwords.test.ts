import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/passwords.js";

describe("passwords", () => {
  it("valida hashes con prefijo $2a$ (formato de Supabase Auth) y $2b$", async () => {
    const hash = await hashPassword("clave-migrada-1");
    expect(hash.startsWith("$2b$")).toBe(true);
    expect(await verifyPassword(hash.replace(/^\$2b\$/, "$2a$"), "clave-migrada-1")).toBe(true);
    expect(await verifyPassword(hash, "otra")).toBe(false);
  });

  it("un hash inválido nunca matchea", async () => {
    expect(await verifyPassword("no-es-un-hash", "x")).toBe(false);
  });
});
