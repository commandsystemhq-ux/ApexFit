import { ConfigError } from './config.js';

// Provider adapters. Both expose complete({ system, messages, tools }) and return
// { text, toolCalls: [{ id, name, args }] } so the agent loop does not care which model is used.
//
// Internal message shapes:
//   { role: 'user' | 'assistant', content, toolCalls? }   (assistant toolCalls: [{ id, name, args }])
//   { role: 'tool', toolCallId, name, content }

export class ModelError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 45_000;

async function postJson(fetchImpl, url, headers, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ModelError(504, 'The AI service did not respond in time.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ModelError(503, 'The AI provider rejected the configured API key.');
    if (response.status === 429) throw new ModelError(429, 'The AI service is busy. Try again in a moment.');
    throw new ModelError(502, 'The AI service returned an error.');
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

export function createOpenAiModel({ apiKey, model = 'gpt-4o-mini', baseUrl = 'https://api.openai.com/v1', fetchImpl = fetch }) {
  return {
    provider: 'openai',
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
        } else {
          payload.push({ role: message.role, content: message.content });
        }
      }

      const body = { model, messages: payload, temperature: 0.3 };
      if (tools?.length) {
        body.tools = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        body.tool_choice = 'auto';
      }

      const data = await postJson(fetchImpl, `${baseUrl}/chat/completions`, { Authorization: `Bearer ${apiKey}` }, body);
      const message = data?.choices?.[0]?.message;
      if (!message) throw new ModelError(502, 'The AI service returned an empty response.');
      return {
        text: typeof message.content === 'string' ? message.content : '',
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
          contents.push({ role: 'user', parts: [{ text: message.content }] });
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

      const data = await postJson(fetchImpl, `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, body);
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

// Chooses the provider from the environment: JACK_PROVIDER, else OpenAI when its key exists, else Gemini.
export function createModelFromEnv(environment = process.env, fetchImpl = fetch) {
  const read = (name) => (environment[name] || '').trim();
  const preferred = read('JACK_PROVIDER').toLowerCase();
  const modelName = read('JACK_MODEL');

  if ((preferred === 'openai' || !preferred) && read('OPENAI_API_KEY')) {
    return createOpenAiModel({ apiKey: read('OPENAI_API_KEY'), model: modelName || undefined, fetchImpl });
  }
  if ((preferred === 'gemini' || !preferred) && read('GEMINI_API_KEY')) {
    return createGeminiModel({ apiKey: read('GEMINI_API_KEY'), model: modelName || undefined, fetchImpl });
  }
  throw new ConfigError('Jack is not configured. Set OPENAI_API_KEY or GEMINI_API_KEY on the server.');
}
