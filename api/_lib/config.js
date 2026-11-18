export class ConfigError extends Error {}

export function env(name, fallbackNames = []) {
  for (const key of [name, ...fallbackNames]) {
    const value = process.env[key];
    if (value) return value;
  }
  throw new ConfigError(`${name} is not configured on the server.`);
}

export function optionalEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

// The site address with spaces, quotes and trailing slashes removed, so `${appUrl()}/path` never has a double slash.
// Returns '' when it is empty and null when it is not a usable web address.
export function normalizeAppUrl(value) {
  const text = String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function appUrl(environment = process.env) {
  const value = normalizeAppUrl(environment.APP_URL);
  if (value === '') throw new ConfigError('APP_URL is not configured on the server. Set it to the address of your site, for example https://your-app.vercel.app');
  if (value === null) throw new ConfigError('APP_URL is not a valid web address. Use the full address of your site, for example https://your-app.vercel.app');
  return value;
}

export function platformFeePercent() {
  const raw = optionalEnv('STRIPE_PLATFORM_FEE_PERCENT', '0');
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    throw new ConfigError('STRIPE_PLATFORM_FEE_PERCENT must be a number between 0 and 50.');
  }
  return percent;
}
