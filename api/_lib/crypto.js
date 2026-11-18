import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from './config.js';

function keyBytes(base64Key) {
  const key = Buffer.from(base64Key || '', 'base64');
  if (key.length !== 32) throw new ConfigError('TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  return key;
}

const encode = (buffer) => Buffer.from(buffer).toString('base64url');
const decode = (text) => Buffer.from(text, 'base64url');

export function encryptSecret(plainText, base64Key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(base64Key), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return ['v1', encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join('.');
}

export function decryptSecret(payload, base64Key) {
  const [version, iv, tag, encrypted] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Unsupported encrypted secret format.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(base64Key), decode(iv));
  decipher.setAuthTag(decode(tag));
  return Buffer.concat([decipher.update(decode(encrypted)), decipher.final()]).toString('utf8');
}

function sign(body, base64Key) {
  return createHmac('sha256', keyBytes(base64Key)).update(`oauth-state:${body}`).digest();
}

export function signState(payload, base64Key, ttlSeconds = 600, now = Date.now()) {
  const body = encode(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
  return `${body}.${encode(sign(body, base64Key))}`;
}

export function verifyState(token, base64Key, now = Date.now()) {
  const [body, signature] = String(token).split('.');
  if (!body || !signature) return null;
  const expected = sign(body, base64Key);
  const provided = decode(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(decode(body).toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}
