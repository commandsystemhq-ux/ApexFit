export const AVATAR_BUCKET = 'avatars';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const NAME_MAX_LENGTH = 80;

const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an error code understood by the UI, or null when the file can be uploaded.
export function validateAvatarFile(file) {
  if (!file || !AVATAR_TYPES[file.type]) return 'avatarTypeError';
  if (file.size > AVATAR_MAX_BYTES) return 'avatarSizeError';
  return null;
}

export function avatarExtension(file) {
  return AVATAR_TYPES[file?.type] || null;
}

export function buildAvatarPath(userId, file, now = Date.now()) {
  const extension = avatarExtension(file);
  if (!userId || !extension) throw new TypeError('A user and a supported image are required.');
  return `${userId}/${now}.${extension}`;
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(String(value || '').trim());
}

// Validates the settings form. Brand name only applies to coaches.
export function normalizeProfileForm({ fullName, brandName, email }, role) {
  const values = {
    fullName: String(fullName || '').trim(),
    brandName: role === 'coach' ? String(brandName || '').trim() : '',
    email: String(email || '').trim(),
  };
  const errors = {};
  if (values.fullName.length > NAME_MAX_LENGTH) errors.fullName = 'profileNameTooLong';
  if (values.brandName.length > NAME_MAX_LENGTH) errors.brandName = 'profileBrandTooLong';
  if (values.email && !isValidEmail(values.email)) errors.email = 'authEmailInvalid';
  return { values, errors, valid: Object.keys(errors).length === 0 };
}

export function displayNameFor(profile, user) {
  return profile?.brand_name || profile?.full_name || user?.user_metadata?.full_name || user?.email || '';
}

export function validateSignupForm({ fullName, email, password, confirmPassword, role }) {
  const errors = {};
  if (role !== 'coach' && role !== 'client') errors.role = 'authRoleRequired';
  if (!String(fullName || '').trim()) errors.fullName = 'authNameRequired';
  else if (String(fullName).trim().length > NAME_MAX_LENGTH) errors.fullName = 'profileNameTooLong';
  if (!isValidEmail(email)) errors.email = 'authEmailInvalid';
  if (String(password || '').length < 8) errors.password = 'authPasswordShort';
  else if (password !== confirmPassword) errors.confirmPassword = 'authPasswordMismatch';
  return errors;
}

export function describeAuthError(error, t) {
  const message = String(error?.message || '');
  if (message.startsWith('Supabase is not configured')) return t('notConfigured');
  if (/invalid login credentials/i.test(message)) return t('authInvalidCredentials');
  if (/email not confirmed/i.test(message)) return t('authEmailNotConfirmed');
  if (/already registered/i.test(message)) return t('authEmailTaken');
  return message || t('authGenericError');
}
