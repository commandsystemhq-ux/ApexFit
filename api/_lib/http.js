import { ConfigError } from './config.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function handler(methods, run) {
  return async function route(req, res) {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw new HttpError(405, 'Method not allowed.');
      }
      await run(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof ConfigError ? 503 : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) {
        res.status(status).json({ error: status === 500 ? 'Unexpected server error.' : error.message });
      }
    }
  };
}

async function readStream(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export async function readRawBody(req) {
  return readStream(req);
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === 'string' ? req.body : (await readStream(req)).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

export function requireUuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, `${label} must be a valid identifier.`);
  }
  return value;
}
