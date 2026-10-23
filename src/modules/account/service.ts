import { withDb } from "../../lib/db.js";
import { randomUUID } from "node:crypto";
import { IMAGE_CONTENT_TYPES, type ImageContentType, keyFromPublicUrl, presignPut, publicUrl, PRESIGN_TTL_SECONDS, deleteReplacedImage } from "../../lib/r2.js";
import { ApiError, notFound } from "../../lib/errors.js";

// Perfil del usuario. RLS: "profiles own select/update" (auth.uid() = id).

export interface ProfileUpdate {
  fullName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
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

/** Solo se aceptan objetos propios, con una key generada para este usuario. */
export function isOwnAvatar(url: string, userId: string): boolean {
  const key = keyFromPublicUrl(url);
  const prefix = `profiles/${userId}/avatar/`;
  return key !== null && key.startsWith(prefix) && /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(key.slice(prefix.length));
}

export async function presignAvatar(userId: string, contentType: ImageContentType, size: number) {
  const key = `profiles/${userId}/avatar/${randomUUID()}.${IMAGE_CONTENT_TYPES[contentType]}`;
  return {
    uploadUrl: await presignPut("public", key, contentType, size),
    publicUrl: publicUrl(key),
    method: "PUT",
    headers: { "Content-Type": contentType },
    expiresIn: PRESIGN_TTL_SECONDS
  };
}

export async function updateProfile(userId: string, email: string, input: ProfileUpdate) {
  if (input.avatarUrl !== undefined && input.avatarUrl !== null && !isOwnAvatar(input.avatarUrl, userId)) {
    throw new ApiError("VALIDATION_ERROR", "La foto debe subirse desde tu cuenta.");
  }
  const result = await withDb(ctx(userId, email), async (tx) => {
    const previous = await tx.profile.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    const { count } = await tx.profile.updateMany({ where: { id: userId }, data: input });
    if (count === 0) return null;
    const profile = await tx.profile.findUnique({ where: { id: userId }, select: profileSelect });
    return profile ? { profile, previous: previous?.avatarUrl } : null;
  });
  if (!result) throw notFound("No encontramos tu perfil.");
  if (input.avatarUrl !== undefined && result.previous && isOwnAvatar(result.previous, userId)) {
    await deleteReplacedImage(result.previous, result.profile.avatarUrl);
  }
  return { ...result.profile, email };
}
