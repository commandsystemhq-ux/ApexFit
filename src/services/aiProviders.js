// The AI providers the platform owner can choose for Jack, the fields each one needs, and the checks on those fields.
// Shared by the platform admin screen (to show the right inputs and explain mistakes) and by the server (which
// repeats every check before anything is stored or called).

export const AI_PROVIDERS = ['openai', 'gemini', 'bedrock', 'azure_foundry'];

// secret: kept encrypted on the server and never sent back to the browser.
export const PROVIDER_FIELDS = {
  openai: [
    { name: 'apiKey', secret: true, required: true },
    { name: 'model', required: false },
  ],
  gemini: [
    { name: 'apiKey', secret: true, required: true },
    { name: 'model', required: false },
  ],
  bedrock: [
    { name: 'region', required: true },
    { name: 'model', required: true },
    { name: 'accessKeyId', secret: true, required: true },
    { name: 'secretAccessKey', secret: true, required: true },
    { name: 'sessionToken', secret: true, required: false },
  ],
  azure_foundry: [
    { name: 'endpoint', required: true },
    { name: 'model', required: true },
    { name: 'apiKey', secret: true, required: true },
  ],
};

export const FIELD_EXAMPLES = {
  openai: { model: 'gpt-4o-mini' },
  gemini: { model: 'gemini-2.0-flash' },
  bedrock: { region: 'us-east-1', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
  azure_foundry: { endpoint: 'https://my-resource.services.ai.azure.com', model: 'gpt-4o' },
};

// Where an Azure AI Foundry / Azure OpenAI resource can live. The server calls this address with the coach's key,
// so only Microsoft's own domains are accepted.
const AZURE_HOST_SUFFIXES = [
  '.openai.azure.com',
  '.services.ai.azure.com',
  '.cognitiveservices.azure.com',
  '.inference.ai.azure.com',
  '.models.ai.azure.com',
  '.openai.azure.us',
  '.services.ai.azure.us',
  '.cognitiveservices.azure.us',
  '.openai.azure.cn',
  '.services.ai.azure.cn',
];

export function normalizeAzureEndpoint(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return null;
  if (!AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return null;
  return `https://${host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const BEDROCK_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,199}$/;
const AZURE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GENERIC_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9\/+=]{20,128}$/;
const PRINTABLE_SECRET = /^[\x21-\x7e]+$/;

const SECRET_RULES = {
  accessKeyId: (value) => ACCESS_KEY_ID.test(value),
  secretAccessKey: (value) => SECRET_ACCESS_KEY.test(value),
  sessionToken: (value) => value.length >= 16 && value.length <= 4000 && PRINTABLE_SECRET.test(value),
  apiKey: (value) => value.length >= 8 && value.length <= 500 && PRINTABLE_SECRET.test(value),
};

function checkField(provider, field, value) {
  switch (field.name) {
    case 'region': return REGION.test(value) ? null : 'aiErrRegion';
    case 'endpoint': return normalizeAzureEndpoint(value) ? null : 'aiErrEndpoint';
    case 'model': {
      const pattern = provider === 'bedrock' ? BEDROCK_MODEL : provider === 'azure_foundry' ? AZURE_MODEL : GENERIC_MODEL;
      return pattern.test(value) ? null : 'aiErrModel';
    }
    default: return SECRET_RULES[field.name]?.(value) ? null : `aiErr_${field.name}`;
  }
}

// input: the fields as typed. savedSecrets: names of the secrets already stored for this provider; leaving one
// blank keeps the stored value. Returns the cleaned values (secrets only when something new was typed).
export function validateAiSettings(provider, input = {}, { savedSecrets = [] } = {}) {
  const fields = PROVIDER_FIELDS[provider];
  if (!fields) return { valid: false, errors: { provider: 'aiErrProvider' }, values: {} };

  const errors = {};
  const values = {};
  for (const field of fields) {
    const raw = typeof input[field.name] === 'string' ? input[field.name].trim() : '';
    if (!raw) {
      if (field.required && !(field.secret && savedSecrets.includes(field.name))) errors[field.name] = 'aiErrRequired';
      continue;
    }
    const problem = checkField(provider, field, raw);
    if (problem) errors[field.name] = problem;
    else values[field.name] = field.name === 'endpoint' ? normalizeAzureEndpoint(raw) : raw;
  }
  return { valid: Object.keys(errors).length === 0, errors, values };
}

export const secretFieldNames = (provider) => (PROVIDER_FIELDS[provider] || []).filter((field) => field.secret).map((field) => field.name);
