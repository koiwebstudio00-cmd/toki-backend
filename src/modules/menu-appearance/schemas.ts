import { z } from "zod";

export const appearanceSchema = z.object({
  layout: z.enum(["visual", "compact", "categories"]),
  color: z.enum(["orange", "green", "blue"]),
  background: z.enum(["white", "warm"]),
  descriptions: z.boolean(),
  cover: z.boolean(),
  featured: z.boolean()
}).strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaultAppearance: Appearance = {
  layout: "visual", color: "orange", background: "warm", descriptions: true, cover: false, featured: true
};
export const saveAppearanceSchema = z.object({
  revision: z.number().int().nonnegative(), settings: appearanceSchema
}).strict();
export const publishAppearanceSchema = z.object({ revision: z.number().int().positive() }).strict();
export function readAppearance(value: unknown): Appearance {
  const parsed = appearanceSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...defaultAppearance };
}
