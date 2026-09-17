import { withDb } from "../../lib/db.js";
import { notFound } from "../../lib/errors.js";

// Perfil del usuario. RLS: "profiles own select/update" (auth.uid() = id).

export interface ProfileUpdate {
  fullName?: string;
  phone?: string | null;
}

const profileSelect = { fullName: true, phone: true, avatarUrl: true } as const;

const ctx = (userId: string, email: string) => ({ role: "authenticated" as const, userId, email });

export async function getProfile(userId: string, email: string) {
  const profile = await withDb(ctx(userId, email), (tx) =>
    tx.profile.findUnique({ where: { id: userId }, select: profileSelect })
  );
  if (!profile) throw notFound("No encontramos tu perfil.");
  return { ...profile, email };
}

export async function updateProfile(userId: string, email: string, input: ProfileUpdate) {
  const profile = await withDb(ctx(userId, email), async (tx) => {
    const { count } = await tx.profile.updateMany({ where: { id: userId }, data: input });
    if (count === 0) return null;
    return tx.profile.findUnique({ where: { id: userId }, select: profileSelect });
  });
  if (!profile) throw notFound("No encontramos tu perfil.");
  return { ...profile, email };
}
