import { timingSafeEqual } from 'node:crypto';

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
export function isAuthorizedCron(header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}