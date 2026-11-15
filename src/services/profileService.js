import { requireSupabase, supabase } from './supabaseClient.js';
import { AVATAR_BUCKET, buildAvatarPath, validateAvatarFile } from './profileUtils.js';

export function getAvatarUrl(avatarPath) {
  if (!avatarPath || !supabase) return '';
  return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath).data.publicUrl;
}

export async function updateMyProfile({ fullName, brandName, avatarPath }) {
  const client = requireSupabase();
  const { data, error } = await client.rpc('update_my_profile', {
    p_full_name: fullName || null,
    p_brand_name: brandName || null,
    p_avatar_path: avatarPath || null,
  });
  if (error) throw error;
  return data;
}

// Uploads a new avatar, points the profile at it, then removes the previous file.
export async function uploadAvatar({ userId, file, profile }) {
  const problem = validateAvatarFile(file);
  if (problem) throw new Error(problem);

  const client = requireSupabase();
  const path = buildAvatarPath(userId, file);
  const { error: uploadError } = await client.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: '3600', upsert: false });
  if (uploadError) throw uploadError;

  let updated;
  try {
    updated = await updateMyProfile({
      fullName: profile?.full_name,
      brandName: profile?.brand_name,
      avatarPath: path,
    });
  } catch (error) {
    await client.storage.from(AVATAR_BUCKET).remove([path]);
    throw error;
  }

  if (profile?.avatar_path) {
    await client.storage.from(AVATAR_BUCKET).remove([profile.avatar_path]).catch(() => {});
  }
  return updated;
}

export async function removeAvatar({ profile }) {
  const client = requireSupabase();
  const updated = await updateMyProfile({
    fullName: profile?.full_name,
    brandName: profile?.brand_name,
    avatarPath: null,
  });
  if (profile?.avatar_path) {
    await client.storage.from(AVATAR_BUCKET).remove([profile.avatar_path]).catch(() => {});
  }
  return updated;
}

// Changing the email sends a confirmation message; the address only changes once it is confirmed.
export async function updateAccountDetails({ email, fullName, currentEmail }) {
  const client = requireSupabase();
  const changes = { data: { full_name: fullName } };
  const emailChanged = Boolean(email) && email.toLowerCase() !== String(currentEmail || '').toLowerCase();
  if (emailChanged) changes.email = email;
  const { error } = await client.auth.updateUser(changes, { emailRedirectTo: `${window.location.origin}/settings` });
  if (error) throw error;
  return { emailChanged };
}
