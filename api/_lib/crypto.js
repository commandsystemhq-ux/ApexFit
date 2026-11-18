import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
