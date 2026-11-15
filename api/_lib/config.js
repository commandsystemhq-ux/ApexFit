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

export function appUrl() {
  return env('APP_URL').replace(/\/+$/, '');
}

export function platformFeePercent() {
  const raw = optionalEnv('STRIPE_PLATFORM_FEE_PERCENT', '0');
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    throw new ConfigError('STRIPE_PLATFORM_FEE_PERCENT must be a number between 0 and 50.');
  }
  return percent;
}
