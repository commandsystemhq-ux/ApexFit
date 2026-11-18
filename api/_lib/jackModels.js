import { signRequest } from './awsSigV4.js';
import { ConfigError } from './config.js';
import { normalizeAzureEndpoint } from '../../src/services/aiProviders.js';

// Provider adapters. Every one exposes complete({ system, messages, tools }) and returns
// { text, toolCalls: [{ id, name, args }] } so the agent loop does not care which model is used.
// Providers: OpenAI, Google Gemini, Amazon Bedrock (Converse API) and Microsoft Azure AI Foundry.
//
// Internal message shapes:
//   { role: 'user' | 'assistant', content, toolCalls?, image? }   (assistant toolCalls: [{ id, name, args }])
//   image (user messages only): { mime: 'image/jpeg' | 'image/png' | 'image/webp', data: <base64> }, a photo to look at
//   { role: 'tool', toolCallId, name, content }

export class ModelError extends Error {
  // `detail` is the provider's own explanation, `providerStatus` its HTTP status (null when there was no answer) and
  // `requestUrl` the address that was called. They are only meant for the platform owner (the AI admin screen and
  // the owner's own chat with Jack) and never reach coaches or clients. Secrets are removed from `detail`; the
  // address never contains one (keys travel in headers).
  constructor(status, message, detail = '', { providerStatus = null, requestUrl = '' } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.providerStatus = providerStatus;
    this.requestUrl = requestUrl;
  }
}

const REQUEST_TIMEOUT_MS = 45_000;
const DETAIL_LIMIT = 300;

function redactText(text, redact) {
  let result = text;
  for (const secret of redact) if (secret && secret.length >= 4) result = result.split(secret).join('***');
  return result.slice(0, DETAIL_LIMIT);
}

async function readErrorDetail(response, redact) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    return '';
  }
  const raw = [data?.error?.message, typeof data?.error === 'string' ? data.error : '', data?.message, data?.Message, data?.error_description]
    .find((value) => typeof value === 'string' && value.trim());
  return redactText((raw || '').replace(/\s+/g, ' ').trim(), redact);
}

// `sign(payload, headers)` may return the final headers (Amazon Bedrock signs the exact bytes it sends).
async function postJson(fetchImpl, url, headers, body, { redact = [], sign } = {}) {
  const payload = JSON.stringify(body);
  const baseHeaders = { 'Content-Type': 'application/json', ...headers };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: sign ? sign(payload, baseHeaders) : baseHeaders,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = String(cause?.cause?.code || cause?.cause?.message || cause?.name || cause?.message || 'no answer');
    throw new ModelError(504, 'The AI service did not respond in time.', redactText(reason, redact), { requestUrl: url });
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response, redact);
    const where = { providerStatus: response.status, requestUrl: url };
    if (response.status === 401 || response.status === 403) throw new ModelError(503, 'The AI provider rejected the configured credentials.', detail, where);
    if (response.status === 429) throw new ModelError(429, 'The AI service is busy. Try again in a moment.', detail, where);
    throw new ModelError(502, 'The AI service returned an error.', detail, where);
  }
  return response.json();
}

function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

// Reasoning models (for example DeepSeek-R1) put their thinking in <think> tags; users should not see it.
const stripThinking = (text) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return '';
}

// OpenAI's chat-completions format. Azure AI Foundry speaks the same format, so it reuses this adapter with its
// own address and headers.
export function createOpenAiModel({
  apiKey, model = 'gpt-4o-mini', baseUrl = 'https://api.openai.com/v1', chatUrl, headers, provider = 'openai',
  temperature = 0.3, removeThinking = false, fetchImpl = fetch,
}) {
  return {
    provider,
    async complete({ system, messages, tools }) {
      const payload = [{ role: 'system', content: system }];
      for (const message of messages) {
        if (message.role === 'tool') {
          payload.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
        } else if (message.role === 'assistant' && message.toolCalls?.length) {
          payload.push({
            role: 'assistant',
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
            })),
          });
        } else if (message.role === 'user' && message.image) {
          payload.push({
            role: 'user',
            content: [
              { type: 'text', text: message.content },
              { type: 'image_url', image_url: { url: `data:${message.image.mime};base64,${message.image.data}` } },
            ],
          });
        } else {
          payload.push({ role: message.role, content: message.content });
        }
      }

      const body = { model, messages: payload };
      if (temperature !== null) body.temperature = temperature;
      if (tools?.length) {
        body.tools = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        body.tool_choice = 'auto';
      }

      const data = await postJson(fetchImpl, chatUrl || `${baseUrl}/chat/completions`, headers || { Authorization: `Bearer ${apiKey}` }, body, { redact: [apiKey] });
      const message = data?.choices?.[0]?.message;
      if (!message) throw new ModelError(502, 'The AI service returned an empty response.');
      const text = textOf(message.content);
      return {
        text: removeThinking ? stripThinking(text) : text,
        toolCalls: (message.tool_calls || []).map((call) => ({
          id: call.id,
          name: call.function?.name,
          args: parseToolArguments(call.function?.arguments),
        })),
      };
    },
  };
}

const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

// Gemini accepts an OpenAPI subset: upper-case types and no additionalProperties.
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const result = {};
  if (GEMINI_TYPES.has(schema.type)) result.type = schema.type.toUpperCase();
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required?.length) result.required = schema.required;
  if (schema.items) result.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  }
  return result;
}

export function createGeminiModel({ apiKey, model = 'gemini-2.0-flash', baseUrl = 'https://generativelanguage.googleapis.com/v1beta', fetchImpl = fetch }) {
  return {
    provider: 'gemini',
    async complete({ system, messages, tools }) {
      const contents = [];
      for (const message of messages) {
        if (message.role === 'tool') {
          const part = { functionResponse: { name: message.name, response: { result: message.content } } };
          const last = contents[contents.length - 1];
          if (last?.role === 'user' && last.parts.every((item) => item.functionResponse)) last.parts.push(part);
          else contents.push({ role: 'user', parts: [part] });
        } else if (message.role === 'assistant') {
          const parts = [];
          if (message.content) parts.push({ text: message.content });
          for (const call of message.toolCalls || []) parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
          if (parts.length) contents.push({ role: 'model', parts });
        } else {
          const parts = [{ text: message.content }];
          if (message.image) parts.push({ inlineData: { mimeType: message.image.mime, data: message.image.data } });
          contents.push({ role: 'user', parts });
        }
      }

      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.3 },
      };
      if (tools?.length) {
        body.tools = [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toGeminiSchema(tool.parameters) })) }];
      }

      const data = await postJson(fetchImpl, `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, body, { redact: [apiKey] });
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) throw new ModelError(502, 'The AI service returned an empty response.');
      return {
        text: parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join(''),
        toolCalls: parts
          .filter((part) => part.functionCall)
          .map((part, index) => ({ id: `call_${index}`, name: part.functionCall.name, args: part.functionCall.args ?? {} })),
      };
    },
  };
}

// ------------------------------------------------------------- Microsoft Azure AI Foundry

const AZURE_OPENAI_API_VERSION = '2024-08-01-preview';
const AZURE_INFERENCE_API_VERSION = '2024-05-01-preview';

const AZURE_OPENAI_HOST = /\.openai\.azure\.(com|us|cn)$/;
const AZURE_SERVICES_HOST = /\.services\.ai\.azure\.(com|us|cn)$/;
const AZURE_SERVERLESS_HOST = /\.(inference|models)\.ai\.azure\.com$/;

// Foundry is reached in two ways, chosen from the endpoint's host:
//   *.openai.azure.com       Azure OpenAI:  /openai/deployments/<deployment>/chat/completions?api-version=2024-08-01-preview
//   *.services.ai.azure.com  Foundry:       /models/chat/completions?api-version=2024-05-01-preview  (model = deployment in the body)
// (*.cognitiveservices.azure.com can be either: OpenAI model names use the first way, the rest the second.)
// Only the host of the endpoint is used. A trailing slash, or a path pasted along with it (/openai, /models,
// /openai/deployments/<name>, /api/projects/<name>), is dropped so segments are never repeated. Two forms are
// kept exactly as given: a complete ".../chat/completions" address, and the OpenAI v1 base ".../openai/v1".
export function azureChatUrl(endpoint, model) {
  const normalized = normalizeAzureEndpoint(endpoint);
  if (!normalized) throw new ConfigError('The Azure AI Foundry endpoint must be an https address on an Azure domain (for example https://my-resource.services.ai.azure.com).');
  const url = new URL(normalized);
  const host = url.hostname;
  const path = url.pathname.replace(/\/+$/, '');

  if (/\/chat\/completions$/.test(path)) {
    if (!url.searchParams.has('api-version') && !/\/openai\/v1\//.test(path)) url.searchParams.set('api-version', AZURE_INFERENCE_API_VERSION);
    return url.toString();
  }
  if (AZURE_SERVERLESS_HOST.test(host)) return `${url.origin}${path || '/v1'}/chat/completions`;
  if (/\/openai\/v1$/.test(path)) return `${url.origin}${path}/chat/completions`;

  const openAiStyle = AZURE_OPENAI_HOST.test(host) || (!AZURE_SERVICES_HOST.test(host) && /^(gpt|o\d|chatgpt)/i.test(model));
  if (openAiStyle) return `${url.origin}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  return `${url.origin}/models/chat/completions?api-version=${AZURE_INFERENCE_API_VERSION}`;
}

export function createAzureFoundryModel({ endpoint, apiKey, model, fetchImpl = fetch }) {
  if (!model) throw new ConfigError('Azure AI Foundry needs a deployment or model name.');
  const chatUrl = azureChatUrl(endpoint, model);
  const { hostname, pathname } = new URL(chatUrl);
  // Azure OpenAI takes the key in api-key only; Foundry also accepts it as a bearer token, so both are sent.
  const azureOpenAi = AZURE_OPENAI_HOST.test(hostname) || /\/openai\/deployments\//.test(pathname);
  return createOpenAiModel({
    apiKey,
    model,
    chatUrl,
    provider: 'azure_foundry',
    headers: azureOpenAi ? { 'api-key': apiKey } : { 'api-key': apiKey, Authorization: `Bearer ${apiKey}` },
    // Reasoning deployments (o-series, gpt-5) only accept the default temperature.
    temperature: /^(o\d|gpt-5)/i.test(model) ? null : 0.3,
    removeThinking: true,
    fetchImpl,
  });
}

// ------------------------------------------------------------------ Amazon Bedrock

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

export function bedrockHost(region) {
  return `bedrock-runtime.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
}

// Converse needs strictly alternating turns that start with the user, tool results inside user turns, and a
// toolConfig whenever tool blocks are present. Without tools (the final wrap-up) tool blocks become plain text.
export function toConverseMessages(messages, withTools) {
  const turns = [];
  const push = (role, blocks) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const text = message.content || '(empty)';
      push('user', withTools ? [{ toolResult: { toolUseId: message.toolCallId, content: [{ text }] } }] : [{ text: `Result of ${message.name}: ${text}` }]);
    } else if (message.role === 'assistant') {
      const blocks = [];
      if (message.content?.trim()) blocks.push({ text: message.content });
      for (const call of message.toolCalls || []) {
        blocks.push(withTools ? { toolUse: { toolUseId: call.id, name: call.name, input: call.args ?? {} } } : { text: `(used ${call.name})` });
      }
      push('assistant', blocks);
    } else {
      const blocks = message.content?.trim() ? [{ text: message.content }] : [];
      if (message.image) blocks.unshift({ image: { format: message.image.mime.replace('image/', ''), source: { bytes: message.image.data } } });
      push('user', blocks);
    }
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export function createBedrockModel({ region, accessKeyId, secretAccessKey, sessionToken, model, fetchImpl = fetch, now = () => new Date() }) {
  if (!REGION_PATTERN.test(region || '')) throw new ConfigError('Amazon Bedrock needs a valid AWS region such as us-east-1.');
  if (!model) throw new ConfigError('Amazon Bedrock needs a model ID.');
  if (!accessKeyId || !secretAccessKey) throw new ConfigError('Amazon Bedrock needs an AWS access key ID and secret access key.');

  return {
    provider: 'bedrock',
    async complete({ system, messages, tools }) {
      const withTools = Boolean(tools?.length);
      const body = {
        system: [{ text: system }],
        messages: toConverseMessages(messages, withTools),
        inferenceConfig: { maxTokens: 2048, temperature: 0.3 },
      };
      if (withTools) {
        body.toolConfig = {
          tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description || tool.name, inputSchema: { json: tool.parameters } } })),
          toolChoice: { auto: {} },
        };
      }

      const url = `https://${bedrockHost(region)}/model/${encodeURIComponent(model)}/converse`;
      const sign = (payload, headers) => signRequest({
        method: 'POST', url, headers, body: payload, region, service: 'bedrock', accessKeyId, secretAccessKey, sessionToken, date: now(),
      }).headers;
      const data = await postJson(fetchImpl, url, {}, body, { redact: [accessKeyId, secretAccessKey, sessionToken], sign });

      const blocks = data?.output?.message?.content;
      if (!Array.isArray(blocks)) throw new ModelError(502, 'The AI service returned an empty response.');
      return {
        text: blocks.filter((block) => typeof block.text === 'string').map((block) => block.text).join(''),
        toolCalls: blocks
          .filter((block) => block.toolUse)
          .map((block) => ({ id: block.toolUse.toolUseId, name: block.toolUse.name, args: block.toolUse.input ?? {} })),
      };
    },
  };
}

// ----------------------------------------------------------- choosing the provider

// Builds a model from a stored configuration: { provider, model, region, endpoint, apiKey, accessKeyId, ... }.
export function createModelFromConfig(config, fetchImpl = fetch) {
  switch (config.provider) {
    case 'openai': return createOpenAiModel({ apiKey: config.apiKey, model: config.model || undefined, fetchImpl });
    case 'gemini': return createGeminiModel({ apiKey: config.apiKey, model: config.model || undefined, fetchImpl });
    case 'azure_foundry': return createAzureFoundryModel({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, fetchImpl });
    case 'bedrock':
      return createBedrockModel({
        region: config.region, model: config.model, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, sessionToken: config.sessionToken || undefined, fetchImpl,
      });
    default: throw new ConfigError('Unknown AI provider.');
  }
}

// The configuration the server's own environment variables describe, per provider, or null when incomplete.
export function envProviderConfigs(environment = process.env) {
  const read = (name) => (environment[name] || '').trim();
  const sharedModel = read('JACK_MODEL');
  const configs = {
    openai: read('OPENAI_API_KEY') ? { provider: 'openai', apiKey: read('OPENAI_API_KEY'), model: sharedModel } : null,
    gemini: read('GEMINI_API_KEY') ? { provider: 'gemini', apiKey: read('GEMINI_API_KEY'), model: sharedModel } : null,
    azure_foundry: null,
    bedrock: null,
  };
  const azureModel = read('AZURE_FOUNDRY_DEPLOYMENT') || read('AZURE_FOUNDRY_MODEL') || sharedModel;
  if (read('AZURE_FOUNDRY_ENDPOINT') && read('AZURE_FOUNDRY_API_KEY') && azureModel) {
    configs.azure_foundry = { provider: 'azure_foundry', endpoint: read('AZURE_FOUNDRY_ENDPOINT'), apiKey: read('AZURE_FOUNDRY_API_KEY'), model: azureModel };
  }
  const bedrockModel = read('BEDROCK_MODEL_ID') || sharedModel;
  const region = read('AWS_REGION') || read('AWS_DEFAULT_REGION');
  if (read('AWS_ACCESS_KEY_ID') && read('AWS_SECRET_ACCESS_KEY') && region && bedrockModel) {
    configs.bedrock = {
      provider: 'bedrock', region, model: bedrockModel, accessKeyId: read('AWS_ACCESS_KEY_ID'), secretAccessKey: read('AWS_SECRET_ACCESS_KEY'), sessionToken: read('AWS_SESSION_TOKEN'),
    };
  }
  return configs;
}

// Chooses the provider from the environment: JACK_PROVIDER (openai, gemini, azure_foundry or bedrock), else the
// first one that is fully configured, in that order.
export function createModelFromEnv(environment = process.env, fetchImpl = fetch) {
  const preferred = (environment.JACK_PROVIDER || '').trim().toLowerCase();
  const configs = envProviderConfigs(environment);
  const chosen = preferred ? configs[preferred] : configs.openai || configs.gemini || configs.azure_foundry || configs.bedrock;
  if (!chosen) {
    throw new ConfigError('Jack is not configured. Set OPENAI_API_KEY, GEMINI_API_KEY, the AZURE_FOUNDRY_* or the AWS Bedrock variables on the server, or choose the provider on the platform AI admin screen.');
  }
  return createModelFromConfig(chosen, fetchImpl);
}
