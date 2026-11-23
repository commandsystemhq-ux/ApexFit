import { ModelError } from './jackModels.js';

const REQUEST_TIMEOUT_MS = 45_000;

// A minimal Anthropic (Claude) adapter for Jack's assistant: text in, text out. It has the same complete() shape as the
// other providers, but no tools, because the assistant asks for finished text or JSON only.
export function createAnthropicModel({ apiKey, model = 'claude-3-5-haiku-latest', baseUrl = 'https://api.anthropic.com/v1', fetchImpl = fetch }) {
  return {
    provider: 'anthropic',
    async complete({ system, messages }) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model,
            max_tokens: 2500,
            temperature: 0.3,
            system,
            messages: messages.filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => ({ role: message.role, content: message.content })),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new ModelError(504, 'The AI service did not respond in time.', String(cause?.name || cause?.message || 'no answer'), { requestUrl: `${baseUrl}/messages` });
      }
      if (!response.ok) {
        const status = response.status;
        const where = { providerStatus: status, requestUrl: `${baseUrl}/messages` };
        if (status === 401 || status === 403) throw new ModelError(503, 'The AI provider rejected the configured credentials.', '', where);
        if (status === 429) throw new ModelError(429, 'The AI service is busy. Try again in a moment.', '', where);
        throw new ModelError(502, 'The AI service returned an error.', '', where);
      }
      const data = await response.json();
      const text = (data?.content || []).map((part) => (part?.type === 'text' ? part.text : '')).join('').trim();
      if (!text) throw new ModelError(502, 'The AI service returned an empty response.');
      return { text, toolCalls: [] };
    },
  };
}
