import { createHash, createHmac } from 'node:crypto';

// AWS Signature Version 4, just enough to call Amazon Bedrock without pulling in the AWS SDK.
// Every input is explicit (including the clock) so the signer can be checked against AWS's published examples.

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Percent-encodes every byte except A-Z a-z 0-9 - _ . ~ (AWS's own rule: spaces are %20, never +).
export function uriEncode(value) {
  return Array.from(Buffer.from(String(value), 'utf8'), (byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~]/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort((left, right) => (left[0] === right[0] ? (left[1] < right[1] ? -1 : 1) : left[0] < right[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

export function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// Returns the headers to send: the ones passed in, plus host, x-amz-date, x-amz-security-token (when there is
// a session token) and Authorization.
export function signRequest({ method = 'POST', url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const target = new URL(url);
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);

  const all = { ...headers, host: target.host, 'x-amz-date': stamp };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;

  const lowered = Object.entries(all)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((left, right) => (left[0] < right[0] ? -1 : 1));
  const canonicalHeaders = lowered.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = lowered.map(([name]) => name).join(';');

  // The path is already percent-encoded as it will be sent; AWS services other than S3 encode it once more.
  const canonicalUri = target.pathname.split('/').map(uriEncode).join('/') || '/';
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery(target), canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = [day, region, service, 'aws4_request'].reduce((key, part) => hmac(key, part), `AWS4${secretAccessKey}`);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const signed = { ...all };
  delete signed.host; // the HTTP client sets it from the URL
  signed.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: signed, canonicalRequest, stringToSign, signature };
}
