import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { signRequest, uriEncode } from '../api/_lib/awsSigV4.js';
import { ConfigError } from '../api/_lib/config.js';
import { HttpError } from '../api/_lib/http.js';
import { parseJackRequest, runJack } from '../api/_lib/jackAgent.js';
import {
  ModelError, azureChatUrl, bedrockHost, createAzureFoundryModel, createBedrockModel, createModelFromConfig, createModelFromEnv, envProviderConfigs, toConverseMessages,
} from '../api/_lib/jackModels.js';
import {
  JACK_UNAVAILABLE, assertPlatformAdmin, createAiStore, decryptCredentials, describeJackFailure, encryptCredentials, environmentSummary, formatProviderFailure, handleAiRequest, isPlatformAdmin,
  platformAdminEmails, resolveJackModel,
} from '../api/_lib/aiSettings.js';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { normalizeAzureEndpoint, validateAiSettings } from '../src/services/aiProviders.js';
import { navigablePages } from '../api/_lib/jackTools.js';
import { ADMIN_PATHS, PAGES } from '../src/routes.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';

// -------------------------------------------------------------------- helpers

const KEY = randomBytes(32).toString('base64');
const ENVIRONMENT = { TOKEN_ENCRYPTION_KEY: KEY };

const BEDROCK_KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const BEDROCK_SETTINGS = { region: 'us-east-1', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0', ...BEDROCK_KEYS };
const AZURE_SETTINGS = { endpoint: 'https://my-resource.services.ai.azure.com', model: 'DeepSeek-R1', apiKey: 'azure-secret-key-123456' };

const SPEC = [{ name: 'get_my_schedule', description: 'Read the schedule', parameters: { type: 'object', properties: { day: { type: 'string' } }, required: ['day'] } }];
const CONVERSATION = [
  { role: 'user', content: 'what is on today?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'tooluse_1', name: 'get_my_schedule', args: { day: 'today' } }] },
  { role: 'tool', toolCallId: 'tooluse_1', name: 'get_my_schedule', content: '{"ok":true}' },
];

function mockFetch(...responses) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    const { ok = true, status = 200, body } = next;
    return { ok, status, json: async () => body };
  };
  impl.requests = requests;
  return impl;
}
const reply = (body, status = 200) => ({ ok: status < 400, status, body });

// ------------------------------------------------------------------- SigV4

test('the request signer matches the example in AWS\'s own documentation', () => {
  const { signature, headers } = signRequest({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    region: 'us-east-1',
    service: 'iam',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.equal(headers.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal('host' in headers, false, 'the HTTP client sets the host itself');
});

test('encoding follows AWS rules and Bedrock model IDs are encoded twice in the signed path', () => {
  assert.equal(uriEncode('a b/c:d~e-f_g.h'), 'a%20b%2Fc%3Ad~e-f_g.h');
  assert.equal(uriEncode('é'), '%C3%A9');
  const { canonicalRequest } = signRequest({
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse',
    headers: { 'content-type': 'application/json' }, body: '{}', region: 'us-east-1', service: 'bedrock', ...BEDROCK_KEYS, sessionToken: 'tok', date: new Date('2026-11-17T10:00:00Z'),
  });
  assert.match(canonicalRequest, /^POST\n\/model\/anthropic\.claude-3-5-sonnet-20241022-v2%253A0\/converse\n\n/);
  assert.match(canonicalRequest, /content-type:application\/json\nhost:bedrock-runtime\.us-east-1\.amazonaws\.com\nx-amz-date:20261117T100000Z\nx-amz-security-token:tok\n\ncontent-type;host;x-amz-date;x-amz-security-token\n/);
});

// ------------------------------------------------------------- Amazon Bedrock

test('Bedrock: a signed Converse request with tools, and tool use read back', async () => {
  const fetchImpl = mockFetch(reply({ output: { message: { role: 'assistant', content: [{ text: 'Checking.' }, { toolUse: { toolUseId: 'tooluse_abc', name: 'get_my_schedule', input: { day: 'today' } } }] } }, stopReason: 'tool_use' }));
  const model = createBedrockModel({ region: 'eu-west-1', model: 'amazon.nova-pro-v1:0', ...BEDROCK_KEYS, fetchImpl, now: () => new Date('2026-11-17T10:00:00Z') });
  const result = await model.complete({ system: 'SYS', messages: CONVERSATION, tools: SPEC });

  const [request] = fetchImpl.requests;
  assert.equal(request.url, 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse');
  assert.match(request.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261117\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(request.headers['x-amz-date'], '20261117T100000Z');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.ok(!JSON.stringify(request.headers).includes(BEDROCK_KEYS.secretAccessKey), 'the secret key is never sent');

  assert.deepEqual(request.body.system, [{ text: 'SYS' }]);
  assert.deepEqual(request.body.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(request.body.messages[1].content, [{ toolUse: { toolUseId: 'tooluse_1', name: 'get_my_schedule', input: { day: 'today' } } }]);
  assert.deepEqual(request.body.messages[2].content, [{ toolResult: { toolUseId: 'tooluse_1', content: [{ text: '{"ok":true}' }] } }]);
  assert.deepEqual(request.body.toolConfig.tools[0], { toolSpec: { name: 'get_my_schedule', description: 'Read the schedule', inputSchema: { json: SPEC[0].parameters } } });
  assert.deepEqual(request.body.toolConfig.toolChoice, { auto: {} });
  assert.deepEqual(result, { text: 'Checking.', toolCalls: [{ id: 'tooluse_abc', name: 'get_my_schedule', args: { day: 'today' } }] });
});

test('Bedrock: the session token is signed and sent, and the signature is checkable', async () => {
  const fetchImpl = mockFetch(reply({ output: { message: { content: [{ text: 'hi' }] } } }));
  const date = new Date('2026-11-17T10:00:00Z');
  const model = createBedrockModel({ region: 'us-east-1', model: 'm.v1:0', ...BEDROCK_KEYS, sessionToken: 'session-token-value-123', fetchImpl, now: () => date });
  await model.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  const [request] = fetchImpl.requests;
  assert.equal(request.headers['x-amz-security-token'], 'session-token-value-123');
  assert.match(request.headers.Authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/);
  const expected = signRequest({
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/m.v1%3A0/converse', headers: { 'Content-Type': 'application/json' }, body: request.raw,
    region: 'us-east-1', service: 'bedrock', ...BEDROCK_KEYS, sessionToken: 'session-token-value-123', date,
  });
  assert.equal(request.headers.Authorization, expected.headers.Authorization, 'the signature covers the exact body that was sent');
});

test('Bedrock: turns alternate, tool results are grouped, and the final wrap-up carries no tool blocks', async () => {
  const messages = [
    { role: 'assistant', content: 'stale greeting' },
    { role: 'user', content: 'plan my week' },
    { role: 'user', content: 'and my meals' },
    { role: 'assistant', content: 'On it', toolCalls: [{ id: 'a', name: 'one', args: { x: 1 } }, { id: 'b', name: 'two', args: null }] },
    { role: 'tool', toolCallId: 'a', name: 'one', content: '{"ok":true}' },
    { role: 'tool', toolCallId: 'b', name: 'two', content: '' },
  ];
  const withTools = toConverseMessages(messages, true);
  assert.deepEqual(withTools.map((turn) => turn.role), ['user', 'assistant', 'user'], 'starts with the user; consecutive turns are merged');
  assert.deepEqual(withTools[0].content, [{ text: 'plan my week' }, { text: 'and my meals' }]);
  assert.deepEqual(withTools[1].content.map((block) => Object.keys(block)[0]), ['text', 'toolUse', 'toolUse']);
  assert.equal(withTools[1].content[2].toolUse.input.constructor, Object);
  assert.deepEqual(withTools[2].content.map((block) => block.toolResult.toolUseId), ['a', 'b']);
  assert.equal(withTools[2].content[1].toolResult.content[0].text, '(empty)');

  const flat = toConverseMessages(messages, false);
  assert.ok(!JSON.stringify(flat).includes('toolUse') && !JSON.stringify(flat).includes('toolResult'));
  assert.deepEqual(flat.map((turn) => turn.role), ['user', 'assistant', 'user']);

  const fetchImpl = mockFetch(reply({ output: { message: { content: [{ text: 'Summary.' }] } } }));
  const model = createBedrockModel({ region: 'us-east-1', model: 'm.v1:0', ...BEDROCK_KEYS, fetchImpl });
  const wrapUp = await model.complete({ system: 's', messages, tools: [] });
  assert.equal('toolConfig' in fetchImpl.requests[0].body, false);
  assert.equal(wrapUp.text, 'Summary.');
});

test('Bedrock: provider errors become safe errors without credentials in the message or the detail', async () => {
  const cases = [
    [403, 503, `User AKIAIOSFODNN7EXAMPLE is not authorized; secret ${BEDROCK_KEYS.secretAccessKey}`],
    [429, 429, 'Too many requests'],
    [400, 502, 'The provided model identifier is invalid.'],
    [500, 502, ''],
  ];
  for (const [status, expected, message] of cases) {
    const model = createBedrockModel({ region: 'us-east-1', model: 'm.v1:0', ...BEDROCK_KEYS, fetchImpl: mockFetch(reply(message ? { message } : {}, status)) });
    await assert.rejects(
      model.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (error) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, expected);
        for (const secret of Object.values(BEDROCK_KEYS)) assert.ok(!error.message.includes(secret) && !error.detail.includes(secret), `${status}: no credentials`);
        if (status === 400) assert.equal(error.detail, 'The provided model identifier is invalid.');
        if (status === 403) assert.match(error.detail, /not authorized; secret \*\*\*/);
        return true;
      },
    );
  }
  await assert.rejects(createBedrockModel({ region: 'us-east-1', model: 'm', ...BEDROCK_KEYS, fetchImpl: async () => { throw new Error('socket hang up'); } }).complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] }), (error) => error.status === 504);
  await assert.rejects(createBedrockModel({ region: 'us-east-1', model: 'm', ...BEDROCK_KEYS, fetchImpl: mockFetch(reply({ output: {} })) }).complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] }), /empty response/);
});

test('Bedrock refuses incomplete or suspicious configuration', () => {
  assert.throws(() => createBedrockModel({ region: 'us-east-1;evil', model: 'm', ...BEDROCK_KEYS }), ConfigError);
  assert.throws(() => createBedrockModel({ region: 'evil.com/', model: 'm', ...BEDROCK_KEYS }), ConfigError);
  assert.throws(() => createBedrockModel({ region: 'us-east-1', ...BEDROCK_KEYS }), /model ID/);
  assert.throws(() => createBedrockModel({ region: 'us-east-1', model: 'm' }), /access key/);
  assert.equal(bedrockHost('us-east-1'), 'bedrock-runtime.us-east-1.amazonaws.com');
  assert.equal(bedrockHost('cn-north-1'), 'bedrock-runtime.cn-north-1.amazonaws.com.cn');
});

// ------------------------------------------------------ Microsoft Azure AI Foundry

const OPENAI_STYLE = (host, deployment) => `https://${host}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
const FOUNDRY_STYLE = (host) => `https://${host}/models/chat/completions?api-version=2024-05-01-preview`;

test('Azure OpenAI endpoints (*.openai.azure.com) call /openai/deployments/<deployment>/chat/completions', () => {
  const host = 'res.openai.azure.com';
  for (const endpoint of [
    `https://${host}`,
    `https://${host}/`,
    `https://${host}//`,
    `https://${host}/openai`,
    `https://${host}/openai/`,
    `https://${host}/openai/deployments/gpt-4o`,
    `https://${host}/openai/deployments/gpt-4o/`,
    `  https://${host}/openai/  `,
    `https://RES.OpenAI.Azure.com/openai`,
    `https://${host}/openai?api-version=2023-05-15`,
  ]) {
    assert.equal(azureChatUrl(endpoint, 'gpt-4o'), OPENAI_STYLE(host, 'gpt-4o'), endpoint);
  }
  assert.equal(azureChatUrl(`https://${host}`, 'my-4o-deployment'), OPENAI_STYLE(host, 'my-4o-deployment'), 'any deployment name, not only gpt-*');
  assert.equal(azureChatUrl(`https://${host}`, 'DeepSeek-R1'), OPENAI_STYLE(host, 'DeepSeek-R1'));
});

test('Azure AI Services / Foundry endpoints (*.services.ai.azure.com) call /models/chat/completions with the model in the body', () => {
  const host = 'res.services.ai.azure.com';
  for (const model of ['gpt-4o', 'DeepSeek-R1', 'Llama-3.3-70B-Instruct', 'o3-mini']) {
    for (const endpoint of [
      `https://${host}`,
      `https://${host}/`,
      `https://${host}//`,
      `https://${host}/models`,
      `https://${host}/models/`,
      `https://${host}/openai`,
      `https://${host}/openai/`,
      `https://${host}/openai/deployments/${model}`,
      `https://${host}/api/projects/my-project`,
      `https://${host}/api/projects/my-project/`,
    ]) {
      assert.equal(azureChatUrl(endpoint, model), FOUNDRY_STYLE(host), `${model} ${endpoint}`);
    }
  }
});

test('Azure endpoint cleaning never repeats a path segment', () => {
  const urls = [
    azureChatUrl('https://a.openai.azure.com/openai/', 'gpt-4o'),
    azureChatUrl('https://a.services.ai.azure.com/models/', 'DeepSeek-R1'),
    azureChatUrl('https://a.services.ai.azure.com/openai/', 'gpt-4o'),
    azureChatUrl('https://a.cognitiveservices.azure.com/openai/', 'gpt-4o'),
    azureChatUrl('https://a.cognitiveservices.azure.com/', 'Llama-3.3-70B-Instruct'),
  ];
  for (const url of urls) {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    assert.equal(new Set(segments).size, segments.length, url);
    assert.ok(!url.includes('//chat') && !url.includes('/openai/openai') && !url.includes('/models/models'), url);
  }
  assert.equal(urls[3], OPENAI_STYLE('a.cognitiveservices.azure.com', 'gpt-4o'), 'OpenAI model names on a multi-service host use the OpenAI path');
  assert.equal(urls[4], FOUNDRY_STYLE('a.cognitiveservices.azure.com'), 'other models use the Foundry path');
});

test('Azure addresses given in full are used as they are', () => {
  assert.equal(azureChatUrl('https://res.openai.azure.com/openai/v1', 'gpt-4o'), 'https://res.openai.azure.com/openai/v1/chat/completions');
  assert.equal(azureChatUrl('https://res.services.ai.azure.com/models/chat/completions', 'x'), 'https://res.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview');
  assert.equal(azureChatUrl('https://res.services.ai.azure.com/models/chat/completions?api-version=2025-01-01', 'x'), 'https://res.services.ai.azure.com/models/chat/completions?api-version=2025-01-01');
  assert.equal(azureChatUrl('https://llama-abc.eastus2.models.ai.azure.com', 'Llama'), 'https://llama-abc.eastus2.models.ai.azure.com/v1/chat/completions');
});

test('Azure AI Foundry only talks to Microsoft domains over https', () => {
  const rejected = [
    'http://res.openai.azure.com',
    'https://evil.com/.openai.azure.com',
    'https://openai.azure.com.evil.com',
    'https://res.openai.azure.com.evil.com',
    'https://evilopenai.azure.com.attacker.io',
    'https://user:pass@res.openai.azure.com',
    'https://res.openai.azure.com:8443',
    'https://127.0.0.1',
    'https://localhost',
    'https://169.254.169.254/latest/meta-data',
    'https://.openai.azure.com',
    'ftp://res.openai.azure.com',
    'res.openai.azure.com',
    '',
    null,
  ];
  for (const endpoint of rejected) {
    assert.equal(normalizeAzureEndpoint(endpoint), null, String(endpoint));
    assert.throws(() => azureChatUrl(endpoint, 'gpt-4o'), ConfigError, String(endpoint));
  }
  assert.equal(normalizeAzureEndpoint(' https://Res.Services.AI.Azure.com/// '), 'https://res.services.ai.azure.com');
  assert.equal(normalizeAzureEndpoint('https://res.cognitiveservices.azure.com:443/path/'), 'https://res.cognitiveservices.azure.com/path');
});

test('Azure AI Foundry: sends tools with the api-key header and reads tool calls and text', async () => {
  const fetchImpl = mockFetch(reply({ choices: [{ message: { content: '<think>let me think</think>\nHello there', tool_calls: [{ id: 'call_9', function: { name: 'get_my_schedule', arguments: '{"day":"today"}' } }] } }] }));
  const model = createAzureFoundryModel({ ...AZURE_SETTINGS, fetchImpl });
  const result = await model.complete({ system: 'SYS', messages: CONVERSATION, tools: SPEC });

  const [request] = fetchImpl.requests;
  assert.equal(request.url, 'https://my-resource.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview');
  assert.equal(request.headers['api-key'], AZURE_SETTINGS.apiKey);
  assert.equal(request.headers.Authorization, `Bearer ${AZURE_SETTINGS.apiKey}`, 'Foundry gets the key both ways');
  assert.equal(request.body.model, 'DeepSeek-R1');
  assert.equal(request.body.temperature, 0.3);
  assert.deepEqual(request.body.messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(request.body.messages[2].tool_calls[0].function.arguments, '{"day":"today"}');
  assert.equal(request.body.tools[0].function.name, 'get_my_schedule');
  assert.equal(request.body.tool_choice, 'auto');
  assert.deepEqual(result, { text: 'Hello there', toolCalls: [{ id: 'call_9', name: 'get_my_schedule', args: { day: 'today' } }] });
  assert.equal(model.provider, 'azure_foundry');
});

test('Azure OpenAI sends the key in api-key only, with the deployment in the address and the model in the body', async () => {
  const fetchImpl = mockFetch(reply({ choices: [{ message: { content: 'ok' } }] }));
  await createAzureFoundryModel({ endpoint: 'https://res.openai.azure.com/openai/', apiKey: AZURE_SETTINGS.apiKey, model: 'gpt-4o', fetchImpl })
    .complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  const [request] = fetchImpl.requests;
  assert.equal(request.url, OPENAI_STYLE('res.openai.azure.com', 'gpt-4o'));
  assert.equal(request.headers['api-key'], AZURE_SETTINGS.apiKey);
  assert.equal('Authorization' in request.headers, false);
  assert.equal(request.body.model, 'gpt-4o');
});

test('Azure AI Foundry: reasoning deployments get no temperature, content parts are joined, serverless also sends a bearer token', async () => {
  const fetchImpl = mockFetch(reply({ choices: [{ message: { content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] } }] }));
  const reasoning = createAzureFoundryModel({ endpoint: 'https://res.openai.azure.com', apiKey: AZURE_SETTINGS.apiKey, model: 'o3-mini', fetchImpl });
  const result = await reasoning.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(result.text, 'Part one. Part two.');
  assert.equal('temperature' in fetchImpl.requests[0].body, false);
  assert.equal('tools' in fetchImpl.requests[0].body, false);

  const serverlessFetch = mockFetch(reply({ choices: [{ message: { content: 'ok' } }] }));
  await createAzureFoundryModel({ endpoint: 'https://llama-abc.eastus2.models.ai.azure.com', apiKey: AZURE_SETTINGS.apiKey, model: 'Llama', fetchImpl: serverlessFetch })
    .complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(serverlessFetch.requests[0].headers.Authorization, `Bearer ${AZURE_SETTINGS.apiKey}`);
  assert.equal(serverlessFetch.requests[0].headers['api-key'], AZURE_SETTINGS.apiKey);

  assert.throws(() => createAzureFoundryModel({ endpoint: 'https://res.openai.azure.com', apiKey: 'k' }), /deployment or model name/);
});

test('Azure AI Foundry: errors are safe and never contain the key', async () => {
  for (const [status, expected] of [[401, 503], [403, 503], [429, 429], [400, 502], [500, 502]]) {
    const fetchImpl = mockFetch(reply({ error: { message: `bad request with ${AZURE_SETTINGS.apiKey} inside` } }, status));
    await assert.rejects(
      createAzureFoundryModel({ ...AZURE_SETTINGS, fetchImpl }).complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (error) => error instanceof ModelError && error.status === expected && !error.message.includes(AZURE_SETTINGS.apiKey) && !error.detail.includes(AZURE_SETTINGS.apiKey) && error.detail.includes('***'),
    );
  }
});

// ---------------------------------------------- the whole agent loop on each new provider

const ALLOWED_CTX = { role: 'client', user: { id: 'u1' } };

async function runLoop(model) {
  const events = [];
  const executed = [];
  await runJack({
    model,
    system: 'SYS',
    history: [{ role: 'user', content: 'what is on today?' }],
    ctx: ALLOWED_CTX,
    emit: (event) => events.push(event),
    execute: async (name, args) => {
      executed.push([name, args]);
      return { ok: true, result: { sessions: ['Legs'] }, meta: { count: 1 } };
    },
  });
  return { events, executed };
}

test('Jack runs a tool through Amazon Bedrock and answers with the result', async () => {
  const fetchImpl = mockFetch(
    reply({ output: { message: { content: [{ toolUse: { toolUseId: 'tooluse_1', name: 'get_my_schedule', input: { day: 'today' } } }] } } }),
    reply({ output: { message: { content: [{ text: 'You have Legs today.' }] } } }),
  );
  const { events, executed } = await runLoop(createBedrockModel({ region: 'us-east-1', model: 'm.v1:0', ...BEDROCK_KEYS, fetchImpl }));

  assert.deepEqual(executed, [['get_my_schedule', { day: 'today' }]]);
  assert.equal(events.at(-1).text, 'You have Legs today.');
  assert.deepEqual(events.filter((event) => event.type === 'step').map((event) => event.status), ['running', 'done']);
  const second = fetchImpl.requests[1].body.messages;
  assert.equal(second.at(-1).content[0].toolResult.toolUseId, 'tooluse_1');
  assert.match(second.at(-1).content[0].toolResult.content[0].text, /Legs/);
  assert.equal(second[1].content[0].toolUse.name, 'get_my_schedule');
});

test('Jack runs a tool through Azure AI Foundry and answers with the result', async () => {
  const fetchImpl = mockFetch(
    reply({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'get_my_schedule', arguments: '{"day":"today"}' } }] } }] }),
    reply({ choices: [{ message: { content: 'You have Legs today.' } }] }),
  );
  const { events, executed } = await runLoop(createAzureFoundryModel({ ...AZURE_SETTINGS, model: 'gpt-4o', fetchImpl }));

  assert.deepEqual(executed, [['get_my_schedule', { day: 'today' }]]);
  assert.equal(events.at(-1).text, 'You have Legs today.');
  const second = fetchImpl.requests[1].body.messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'call_1');
});

test('a tool budget that runs out still ends with a plain answer on Bedrock', async () => {
  const toolTurn = reply({ output: { message: { content: [{ toolUse: { toolUseId: 'tooluse_x', name: 'get_my_schedule', input: { day: 'today' } } }] } } });
  const fetchImpl = mockFetch(toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, reply({ output: { message: { content: [{ text: 'Done for now.' }] } } }));
  const { events } = await runLoop(createBedrockModel({ region: 'us-east-1', model: 'm.v1:0', ...BEDROCK_KEYS, fetchImpl }));
  assert.equal(events.at(-1).text, 'Done for now.');
  const last = fetchImpl.requests.at(-1).body;
  assert.equal('toolConfig' in last, false);
  assert.ok(!JSON.stringify(last.messages).includes('toolUse'));
});

// ------------------------------------------------------- choosing from the environment

test('the environment can select Bedrock or Azure AI Foundry, and incomplete setups are ignored', () => {
  const bedrock = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: BEDROCK_KEYS.accessKeyId, AWS_SECRET_ACCESS_KEY: BEDROCK_KEYS.secretAccessKey, BEDROCK_MODEL_ID: 'amazon.nova-pro-v1:0' };
  const azure = { AZURE_FOUNDRY_ENDPOINT: AZURE_SETTINGS.endpoint, AZURE_FOUNDRY_API_KEY: AZURE_SETTINGS.apiKey, AZURE_FOUNDRY_MODEL: 'gpt-4o' };

  assert.equal(createModelFromEnv(bedrock).provider, 'bedrock');
  assert.equal(createModelFromEnv(azure).provider, 'azure_foundry');
  assert.equal(createModelFromEnv({ ...azure, ...bedrock }).provider, 'azure_foundry', 'azure comes before bedrock when nothing is chosen');
  assert.equal(createModelFromEnv({ ...azure, ...bedrock, JACK_PROVIDER: 'bedrock' }).provider, 'bedrock');
  assert.equal(createModelFromEnv({ ...azure, OPENAI_API_KEY: 'sk-1' }).provider, 'openai');
  assert.equal(createModelFromEnv({ ...azure, AZURE_FOUNDRY_MODEL: '', JACK_MODEL: 'DeepSeek-R1' }).provider, 'azure_foundry');
  assert.equal(createModelFromEnv({ ...bedrock, BEDROCK_MODEL_ID: '', JACK_MODEL: 'amazon.nova-lite-v1:0' }).provider, 'bedrock');

  assert.throws(() => createModelFromEnv({ ...bedrock, BEDROCK_MODEL_ID: '' }), /not configured/, 'no model id');
  assert.throws(() => createModelFromEnv({ ...bedrock, AWS_REGION: '' }), /not configured/, 'no region');
  assert.throws(() => createModelFromEnv({ ...azure, AZURE_FOUNDRY_API_KEY: '' }), /not configured/);
  assert.throws(() => createModelFromEnv({ ...azure, JACK_PROVIDER: 'bedrock' }), /not configured/);
  assert.throws(() => createModelFromEnv({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'x' }), /not configured/, 'AWS keys alone do not switch Jack on');
  assert.throws(() => createModelFromConfig({ provider: 'mystery' }), ConfigError);

  assert.deepEqual(environmentSummary({ ...azure, JACK_PROVIDER: 'azure_foundry' }), { available: { openai: false, gemini: false, bedrock: false, azure_foundry: true }, effective: 'azure_foundry', canStoreCredentials: false });
});

// -------------------------------------------------------------- field validation

test('provider settings are validated field by field', () => {
  assert.equal(validateAiSettings('bedrock', BEDROCK_SETTINGS).valid, true);
  assert.equal(validateAiSettings('azure_foundry', AZURE_SETTINGS).valid, true);
  assert.equal(validateAiSettings('openai', { apiKey: 'sk-test-12345' }).valid, true);
  assert.equal(validateAiSettings('gemini', { apiKey: 'AIza-test-12345', model: 'gemini-2.0-flash' }).valid, true);

  assert.deepEqual(validateAiSettings('bedrock', {}).errors, { region: 'aiErrRequired', model: 'aiErrRequired', accessKeyId: 'aiErrRequired', secretAccessKey: 'aiErrRequired' });
  assert.deepEqual(validateAiSettings('bedrock', { ...BEDROCK_SETTINGS, region: 'Virginia', model: 'bad model!', accessKeyId: 'akia', secretAccessKey: 'short', sessionToken: 'x' }).errors, {
    region: 'aiErrRegion', model: 'aiErrModel', accessKeyId: 'aiErr_accessKeyId', secretAccessKey: 'aiErr_secretAccessKey', sessionToken: 'aiErr_sessionToken',
  });
  assert.deepEqual(validateAiSettings('azure_foundry', { endpoint: 'https://evil.example.com', model: 'a b', apiKey: 'short' }).errors, { endpoint: 'aiErrEndpoint', model: 'aiErrModel', apiKey: 'aiErr_apiKey' });
  assert.equal(validateAiSettings('mystery', {}).errors.provider, 'aiErrProvider');

  // Credentials that are already stored may be left empty; everything else still has to be filled in.
  const kept = validateAiSettings('bedrock', { region: 'us-east-1', model: 'amazon.nova-pro-v1:0' }, { savedSecrets: ['accessKeyId', 'secretAccessKey'] });
  assert.deepEqual([kept.valid, kept.values], [true, { region: 'us-east-1', model: 'amazon.nova-pro-v1:0' }]);
  assert.equal(validateAiSettings('bedrock', { model: 'amazon.nova-pro-v1:0' }, { savedSecrets: ['accessKeyId', 'secretAccessKey'] }).errors.region, 'aiErrRequired');
  assert.equal(validateAiSettings('azure_foundry', { ...AZURE_SETTINGS, endpoint: 'https://Res.Services.AI.Azure.com/' }).values.endpoint, 'https://res.services.ai.azure.com');
});

// ------------------------------------------- the platform owner: who, storage, test

function memoryStore(initial = null) {
  const calls = [];
  const state = { row: initial, test: null, savedBy: null };
  return {
    state,
    calls,
    async get() {
      calls.push('get');
      return state.row && {
        provider: state.row.provider, model: state.row.model, region: state.row.region, endpoint: state.row.endpoint,
        credentials_encrypted: state.row.credentialsEncrypted, updated_at: '2026-11-17T10:00:00Z',
        last_tested_at: state.test === null ? null : '2026-11-17T10:05:00Z', last_test_ok: state.test,
      };
    },
    async save(row, userId) {
      calls.push('save');
      state.row = row;
      state.savedBy = userId;
      state.test = null;
    },
    async clear() {
      calls.push('clear');
      state.row = null;
    },
    async recordTest(ok) {
      calls.push('recordTest');
      state.test = ok;
    },
  };
}

const PLATFORM_ENV = { ...ENVIRONMENT, PLATFORM_ADMIN_EMAILS: 'Owner@Example.com, second@example.com' };
const OWNER = { id: 'owner-1', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const request = (store, body, extra = {}) => handleAiRequest({ body, user: OWNER, store, environment: PLATFORM_ENV, ...extra });

test('only people listed in PLATFORM_ADMIN_EMAILS, with a confirmed email, are platform admins', () => {
  assert.deepEqual(platformAdminEmails({ PLATFORM_ADMIN_EMAILS: ' A@x.com;b@y.com\nc@z.com , nonsense, ' }), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(platformAdminEmails({}), []);

  assert.equal(isPlatformAdmin(OWNER, PLATFORM_ENV), true);
  assert.equal(isPlatformAdmin({ ...OWNER, email: 'SECOND@example.com' }, PLATFORM_ENV), true, 'case does not matter');
  assert.equal(isPlatformAdmin({ ...OWNER, email_confirmed_at: undefined, confirmed_at: '2026-01-01' }, PLATFORM_ENV), true);

  const refused = [
    { ...OWNER, email_confirmed_at: undefined },
    { ...OWNER, email: 'owner@example.com.evil.io' },
    { ...OWNER, email: 'evil-owner@example.com' },
    { ...OWNER, email: 'owner+tag@example.com' },
    { ...OWNER, email: 'someone@example.com' },
    { ...OWNER, email: '' },
    { id: 'x' },
    null,
    undefined,
  ];
  for (const user of refused) {
    assert.equal(isPlatformAdmin(user, PLATFORM_ENV), false, JSON.stringify(user));
    assert.throws(() => assertPlatformAdmin(user, PLATFORM_ENV), (error) => error instanceof HttpError && error.status === 403);
  }
  assert.equal(isPlatformAdmin(OWNER, {}), false, 'with no list, nobody is an admin');
  assert.equal(isPlatformAdmin(OWNER, { PLATFORM_ADMIN_EMAILS: '' }), false);
});

test('coaches, assistant trainers and clients are refused every action before the database is even opened', async () => {
  // Their role does not matter: only the verified email address does. A coach or client cannot claim to be the owner.
  const people = [
    { id: 'coach-1', email: 'coach@example.com', email_confirmed_at: '2026-01-01', app_metadata: { role: 'coach' } },
    { id: 'trainer-1', email: 'trainer@example.com', email_confirmed_at: '2026-01-01', user_metadata: { role: 'coach', access_state: 'trainer' } },
    { id: 'client-1', email: 'client@example.com', email_confirmed_at: '2026-01-01', user_metadata: { role: 'super_admin', admin: true } },
    { id: 'client-2', email: 'owner@example.com', email_confirmed_at: null },
  ];
  for (const user of people) {
    for (const action of ['get', 'save', 'test', 'clear', 'whatever', undefined]) {
      let opened = 0;
      await assert.rejects(
        handleAiRequest({ body: { action, provider: 'bedrock', settings: BEDROCK_SETTINGS, admin: true, role: 'super_admin' }, user, store: () => { opened += 1; return memoryStore(); }, environment: PLATFORM_ENV }),
        (error) => error instanceof HttpError && error.status === 403,
        `${user.id} ${action}`,
      );
      assert.equal(opened, 0, 'the store was never created');
    }
    const status = await handleAiRequest({ body: { action: 'status' }, user, store: () => { throw new Error('no store for status'); }, environment: PLATFORM_ENV });
    assert.deepEqual(status, { status: 200, body: { admin: false } }, 'they only learn that they are not the owner');
  }
  assert.deepEqual((await handleAiRequest({ body: { action: 'status' }, user: OWNER, store: () => memoryStore(), environment: PLATFORM_ENV })).body, { admin: true });
});

test('saving encrypts the credentials; reading them back never exposes a secret value', async () => {
  const store = memoryStore();
  const saved = await request(store, { action: 'save', provider: 'bedrock', settings: { ...BEDROCK_SETTINGS, sessionToken: 'session-token-value-1234' } });
  assert.equal(saved.status, 200);
  assert.equal(store.state.savedBy, 'owner-1');

  const row = store.state.row;
  assert.deepEqual([row.provider, row.model, row.region, row.endpoint], ['bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0', 'us-east-1', null]);
  for (const secret of [BEDROCK_KEYS.accessKeyId, BEDROCK_KEYS.secretAccessKey, 'session-token-value-1234']) {
    assert.ok(!JSON.stringify(row).includes(secret), 'ciphertext only at rest');
  }
  assert.deepEqual(decryptCredentials(row.credentialsEncrypted, PLATFORM_ENV), { ...BEDROCK_KEYS, sessionToken: 'session-token-value-1234' });

  const shown = JSON.stringify((await request(store, { action: 'get' })).body);
  for (const secret of [BEDROCK_KEYS.accessKeyId, BEDROCK_KEYS.secretAccessKey, 'session-token-value-1234', row.credentialsEncrypted]) assert.ok(!shown.includes(secret));
  const view = JSON.parse(shown);
  assert.deepEqual([view.configured, view.provider, view.region, view.secrets], [true, 'bedrock', 'us-east-1', { accessKeyId: true, secretAccessKey: true, sessionToken: true }]);
});

test('a later save keeps credentials left empty, replaces new ones, and may drop the optional token', async () => {
  const store = memoryStore();
  await request(store, { action: 'save', provider: 'bedrock', settings: { ...BEDROCK_SETTINGS, sessionToken: 'session-token-value-1234' } });

  await request(store, { action: 'save', provider: 'bedrock', settings: { region: 'eu-west-1', model: 'amazon.nova-pro-v1:0' } });
  assert.deepEqual(decryptCredentials(store.state.row.credentialsEncrypted, PLATFORM_ENV), { ...BEDROCK_KEYS, sessionToken: 'session-token-value-1234' });
  assert.deepEqual([store.state.row.region, store.state.row.model], ['eu-west-1', 'amazon.nova-pro-v1:0']);

  await request(store, { action: 'save', provider: 'bedrock', settings: { region: 'eu-west-1', model: 'amazon.nova-pro-v1:0', secretAccessKey: 'newSecretAccessKey0123456789ABCDEFGHIJ' } });
  assert.equal(decryptCredentials(store.state.row.credentialsEncrypted, PLATFORM_ENV).secretAccessKey, 'newSecretAccessKey0123456789ABCDEFGHIJ');

  await request(store, { action: 'save', provider: 'bedrock', settings: { region: 'eu-west-1', model: 'amazon.nova-pro-v1:0' }, removeSecrets: ['sessionToken', 'accessKeyId'] });
  const creds = decryptCredentials(store.state.row.credentialsEncrypted, PLATFORM_ENV);
  assert.equal('sessionToken' in creds, false, 'optional credentials can be removed');
  assert.equal(creds.accessKeyId, BEDROCK_KEYS.accessKeyId, 'required credentials cannot be removed');
});

test('switching provider drops the old credentials and requires the new ones', async () => {
  const store = memoryStore();
  await request(store, { action: 'save', provider: 'bedrock', settings: BEDROCK_SETTINGS });
  const missing = await request(store, { action: 'save', provider: 'azure_foundry', settings: { endpoint: AZURE_SETTINGS.endpoint, model: 'gpt-4o' } });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.errors.apiKey, 'aiErrRequired');
  assert.equal(store.state.row.provider, 'bedrock', 'a refused save changes nothing');

  const switched = await request(store, { action: 'save', provider: 'azure_foundry', settings: AZURE_SETTINGS });
  assert.equal(switched.status, 200);
  assert.deepEqual(decryptCredentials(store.state.row.credentialsEncrypted, PLATFORM_ENV), { apiKey: AZURE_SETTINGS.apiKey });
  assert.deepEqual([store.state.row.endpoint, store.state.row.region], [AZURE_SETTINGS.endpoint, null]);
});

test('invalid input is refused with field errors, and nothing can be stored without the encryption key', async () => {
  const store = memoryStore();
  const bad = await request(store, { action: 'save', provider: 'azure_foundry', settings: { ...AZURE_SETTINGS, endpoint: 'https://169.254.169.254/' } });
  assert.deepEqual([bad.status, bad.body.errors], [422, { endpoint: 'aiErrEndpoint' }]);
  assert.equal((await request(store, { action: 'save', provider: 'nope', settings: {} })).body.errors.provider, 'aiErrProvider');
  assert.equal((await request(store, { action: 'save', settings: {} })).status, 422);
  assert.equal(store.calls.includes('save'), false);

  const withoutKey = { PLATFORM_ADMIN_EMAILS: 'owner@example.com' };
  await assert.rejects(handleAiRequest({ body: { action: 'save', provider: 'bedrock', settings: BEDROCK_SETTINGS }, user: OWNER, store, environment: withoutKey }), ConfigError);
  assert.equal(store.calls.includes('save'), false);
  await assert.rejects(request(store, { action: 'explode' }), (error) => error instanceof HttpError && error.status === 400);
});

test('Test connection checks the connection and tool calling, for typed values and for saved ones', async () => {
  const store = memoryStore();
  const bedrockFetch = mockFetch(
    reply({ output: { message: { content: [{ text: 'OK' }] } } }),
    reply({ output: { message: { content: [{ toolUse: { toolUseId: 't1', name: 'ping', input: { value: 'pong' } } }] } } }),
  );
  const draft = await request(store, { action: 'test', provider: 'bedrock', settings: BEDROCK_SETTINGS }, { fetchImpl: bedrockFetch });
  assert.equal(draft.status, 200);
  assert.deepEqual([draft.body.ok, draft.body.provider, draft.body.source, draft.body.toolsOk, draft.body.reply], [true, 'bedrock', 'draft', true, 'OK']);
  assert.equal(bedrockFetch.requests.length, 2);
  assert.equal(store.calls.includes('recordTest'), false, 'a draft is not recorded');
  assert.ok(!JSON.stringify(draft.body).includes(BEDROCK_KEYS.secretAccessKey));

  await request(store, { action: 'save', provider: 'azure_foundry', settings: AZURE_SETTINGS });
  const azureFetch = mockFetch(
    reply({ choices: [{ message: { content: 'OK' } }] }),
    reply({ choices: [{ message: { content: 'no tool used' } }] }),
  );
  const saved = await request(store, { action: 'test' }, { fetchImpl: azureFetch });
  assert.deepEqual([saved.body.ok, saved.body.source, saved.body.toolsOk], [true, 'saved', false]);
  assert.match(saved.body.toolsNote, /without using the tool/);
  assert.equal(azureFetch.requests[0].headers['api-key'], AZURE_SETTINGS.apiKey, 'saved credentials are used');
  assert.equal(store.state.test, true, 'a test of the saved settings is recorded');
  assert.deepEqual((await request(store, { action: 'get' })).body.lastTest, { at: '2026-11-17T10:05:00Z', ok: true });
});

test('Test connection reports failures to the owner with the provider\'s explanation and no secrets', async () => {
  const store = memoryStore();
  const failing = mockFetch(reply({ message: `Access denied for ${BEDROCK_KEYS.accessKeyId}` }, 403));
  const result = await request(store, { action: 'test', provider: 'bedrock', settings: BEDROCK_SETTINGS }, { fetchImpl: failing });
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.ok, result.body.status, result.body.error], [false, 503, 'The AI provider rejected the configured credentials.']);
  assert.equal(result.body.detail, 'Access denied for ***');
  assert.ok(!JSON.stringify(result.body).includes(BEDROCK_KEYS.accessKeyId));

  // The tool check failing does not fail the connection.
  const noTools = mockFetch(reply({ choices: [{ message: { content: 'OK' } }] }), reply({ error: { message: 'This model does not support tools' } }, 400));
  const partial = await request(store, { action: 'test', provider: 'azure_foundry', settings: AZURE_SETTINGS }, { fetchImpl: noTools });
  assert.deepEqual([partial.body.ok, partial.body.toolsOk, partial.body.toolsNote], [true, false, 'This model does not support tools']);

  const invalid = await request(store, { action: 'test', provider: 'bedrock', settings: { region: 'nope' } });
  assert.equal(invalid.status, 422);

  const failingSaved = memoryStore();
  await request(failingSaved, { action: 'save', provider: 'bedrock', settings: BEDROCK_SETTINGS });
  await request(failingSaved, { action: 'test' }, { fetchImpl: failing });
  assert.equal(failingSaved.state.test, false);
});

test('Test connection without a saved setting tests the environment variables, or says there are none', async () => {
  const store = memoryStore();
  const none = await request(store, { action: 'test' });
  assert.deepEqual([none.body.ok, none.body.source], [false, 'environment']);
  assert.match(none.body.error, /not configured/);

  const env = { ...PLATFORM_ENV, OPENAI_API_KEY: 'sk-platform-key-123' };
  const fetchImpl = mockFetch(reply({ choices: [{ message: { content: 'OK' } }] }));
  const platform = await handleAiRequest({ body: { action: 'test' }, user: OWNER, store, environment: env, fetchImpl });
  assert.deepEqual([platform.body.ok, platform.body.provider, platform.body.source], [true, 'openai', 'environment']);
});

test('removing the saved setting returns Jack to the environment variables', async () => {
  const store = memoryStore();
  await request(store, { action: 'save', provider: 'bedrock', settings: BEDROCK_SETTINGS });
  const cleared = await request(store, { action: 'clear' });
  assert.deepEqual([store.state.row, cleared.body.configured, cleared.body.secrets], [null, false, {}]);
});

test('credentials that cannot be decrypted are reported, not guessed', async () => {
  const store = memoryStore();
  await request(store, { action: 'save', provider: 'azure_foundry', settings: AZURE_SETTINGS });
  const rotated = { ...PLATFORM_ENV, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  const view = (await handleAiRequest({ body: { action: 'get' }, user: OWNER, store, environment: rotated })).body;
  assert.deepEqual([view.configured, view.unreadable, view.secrets], [true, true, {}]);
  assert.throws(() => decryptCredentials(store.state.row.credentialsEncrypted, rotated), /could not be read/);
  assert.equal(encryptCredentials({ a: 1 }, PLATFORM_ENV) === encryptCredentials({ a: 1 }, PLATFORM_ENV), false, 'every encryption is different');
});

// The database client is the service role's; this fake records what the store asks of it.
function fakeAdmin({ row = null, error = null } = {}) {
  const calls = [];
  const query = (table) => {
    const chain = {
      select: (columns) => { calls.push([table, 'select', columns]); return chain; },
      eq: (column, value) => { calls.push([table, 'eq', column, value]); return chain; },
      maybeSingle: async () => ({ data: error ? null : row, error }),
      upsert: async (payload, options) => { calls.push([table, 'upsert', payload, options]); return { error }; },
      update: (payload) => { calls.push([table, 'update', payload]); return chain; },
      delete: () => { calls.push([table, 'delete']); return chain; },
      then: (resolve) => resolve({ error }),
    };
    return chain;
  };
  return { calls, from: query };
}

test('the platform setting is one row in platform_ai_settings, reached through the service role', async () => {
  const admin = fakeAdmin({ row: { provider: 'openai' } });
  const store = createAiStore({ admin });
  assert.deepEqual(await store.get(), { provider: 'openai' });
  await store.save({ provider: 'gemini', model: null, region: null, endpoint: null, credentialsEncrypted: 'cipher' }, 'owner-1');
  await store.clear();
  await store.recordTest(true);

  assert.deepEqual(admin.calls.map((call) => call[0]), Array(admin.calls.length).fill('platform_ai_settings'));
  const upsert = admin.calls.find((call) => call[1] === 'upsert');
  assert.equal(upsert[2].id, true);
  assert.deepEqual([upsert[2].provider, upsert[2].credentials_encrypted, upsert[2].updated_by, upsert[3]], ['gemini', 'cipher', 'owner-1', { onConflict: 'id' }]);
  assert.ok(admin.calls.some((call) => call[1] === 'delete'));
  assert.ok(admin.calls.filter((call) => call[1] === 'eq').every((call) => call[2] === 'id' && call[3] === true));

  await assert.rejects(createAiStore({ admin: fakeAdmin({ error: { message: 'boom' } }) }).get(), /boom/);
});

// ----------------------------------------- one model for everyone on the platform

test('Jack runs on one platform model: the saved platform setting first, then the environment variables', async () => {
  const store = memoryStore();
  await request(store, { action: 'save', provider: 'bedrock', settings: BEDROCK_SETTINGS });
  const row = await store.get();
  const environment = { ...PLATFORM_ENV, OPENAI_API_KEY: 'sk-env' };

  const admin = fakeAdmin({ row });
  const platform = await resolveJackModel({ admin, environment });
  assert.deepEqual([platform.source, platform.model.provider], ['database', 'bedrock']);
  assert.deepEqual(admin.calls.slice(0, 2), [['platform_ai_settings', 'select', '*'], ['platform_ai_settings', 'eq', 'id', true]]);

  const fallback = await resolveJackModel({ admin: fakeAdmin({ row: null }), environment });
  assert.deepEqual([fallback.source, fallback.model.provider], ['environment', 'openai']);

  const withoutAdmin = await resolveJackModel({ admin: null, environment });
  assert.equal(withoutAdmin.source, 'environment');

  const unreachable = await resolveJackModel({ admin: fakeAdmin({ error: { message: 'relation does not exist' } }), environment });
  assert.equal(unreachable.source, 'environment', 'a database without the migration still works through the environment');

  await assert.rejects(resolveJackModel({ admin: fakeAdmin({ row }), environment: { TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') } }), /could not be read/);
  await assert.rejects(resolveJackModel({ admin: fakeAdmin({ row: null }), environment: {} }), /not configured/);
});

test('every kind of user gets the same model, and its first request goes to the platform provider', async () => {
  const store = memoryStore();
  await request(store, { action: 'save', provider: 'azure_foundry', settings: { ...AZURE_SETTINGS, model: 'gpt-4o' } });
  const row = await store.get();

  const urls = [];
  for (const role of ['coach', 'trainer', 'client']) {
    const fetchImpl = mockFetch(reply({ choices: [{ message: { content: `hi ${role}` } }] }));
    const { model } = await resolveJackModel({ admin: fakeAdmin({ row }), environment: PLATFORM_ENV, fetchImpl });
    const answer = await model.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(answer.text, `hi ${role}`);
    assert.equal(fetchImpl.requests[0].headers['api-key'], AZURE_SETTINGS.apiKey);
    urls.push(fetchImpl.requests[0].url);
  }
  assert.deepEqual([...new Set(urls)], ['https://my-resource.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview']);
});

test('the environment names for Azure: the deployment variable wins over the older model variable', () => {
  const azure = { AZURE_FOUNDRY_ENDPOINT: AZURE_SETTINGS.endpoint, AZURE_FOUNDRY_API_KEY: AZURE_SETTINGS.apiKey };
  const model = createModelFromEnv({ ...azure, AZURE_FOUNDRY_DEPLOYMENT: 'gpt-4o', AZURE_FOUNDRY_MODEL: 'ignored' }, mockFetch(reply({ choices: [{ message: { content: 'ok' } }] })));
  assert.equal(model.provider, 'azure_foundry');
  assert.deepEqual(Object.keys(envProviderConfigs({ ...azure, AZURE_FOUNDRY_DEPLOYMENT: 'gpt-4o', AZURE_FOUNDRY_MODEL: 'old' })).filter((name) => envProviderConfigs({ ...azure, AZURE_FOUNDRY_DEPLOYMENT: 'gpt-4o' })[name]), ['azure_foundry']);
  assert.equal(envProviderConfigs({ ...azure, AZURE_FOUNDRY_DEPLOYMENT: 'gpt-4o', AZURE_FOUNDRY_MODEL: 'old' }).azure_foundry.model, 'gpt-4o');
  assert.equal(envProviderConfigs({ ...azure, AZURE_FOUNDRY_MODEL: 'old' }).azure_foundry.model, 'old');
});

// ---------------------------------- nothing about the provider reaches coaches or clients

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('no coach, trainer or client screen, route or Jack text offers or mentions AI provider settings', () => {
  // The only places that may use the AI settings client: the admin page and its panel.
  const users = ['src/pages', 'src/components'].flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).map((name) => `${dir}/${name}`))
    .filter((path) => /\.jsx?$/.test(path) && /aiSettingsService|PlatformAiPanel|aiProviders/.test(read(path)));
  assert.deepEqual(users.sort(), ['src/components/PlatformAiPanel.jsx', 'src/pages/AdminAiPage.jsx', 'src/pages/AdminIntegrationsPage.jsx', 'src/pages/SettingsPage.jsx']);
  assert.ok(!/PlatformAiPanel|PROVIDER_FIELDS|AI_PROVIDERS/.test(read('src/pages/SettingsPage.jsx')), 'the settings page has no provider controls');
  assert.match(read('src/pages/SettingsPage.jsx'), /getAiStatus/);
  assert.ok(!/getAiSettings|saveAiSettings|testAiSettings|clearAiSettings/.test(read('src/pages/SettingsPage.jsx')));

  // Not part of any role's navigation, and Jack cannot send anyone there.
  for (const page of Object.values(PAGES)) assert.ok(!page.path.startsWith('/admin'), page.path);
  for (const role of ['coach', 'client', 'trainer']) {
    assert.ok(!navigablePages(role).some((id) => PAGES[id].path.startsWith('/admin')), role);
    const prompt = buildSystemPrompt({ role, locale: 'en', route: '/settings', pageTitle: 'settings', name: 'Sam', summary: '', today: '2026-11-17' });
    assert.doesNotMatch(prompt, /AI provider|Bedrock|Azure|Foundry|OpenAI|Gemini|admin\/ai/i, role);
  }
  assert.equal(ADMIN_PATHS.ai, '/admin/ai');

  // The old per-coach settings are gone everywhere.
  for (const path of ['api/_lib/aiSettings.js', 'api/ai.js', 'api/jack.js', 'src/services/aiSettingsService.js', 'src/pages/SettingsPage.jsx', 'README.md', '.env.example']) {
    assert.doesNotMatch(read(path), /coach_ai_settings|save_my_ai_settings|get_my_ai_settings|resolve_ai_owner|service_get_ai_settings|canSeeAiSettings/, path);
  }
  assert.ok(!existsSync(new URL('../supabase/migrations/20261115001600_ai_provider_settings.sql', import.meta.url)));
});

test('Jack hides the provider\'s own error text from everyone who talks to it', () => {
  const source = read('api/jack.js');
  assert.match(read('api/_lib/aiSettings.js'), /Jack is unavailable right now/);
  assert.doesNotMatch(source, /role === 'coach' \? error\.message/);
  assert.doesNotMatch(source, /message: error\.detail|emit\(\{ type: 'error', message: error\.message/);
  assert.match(source, /resolveJackModel\(\{ admin: serviceClient \}\)/, 'one model for the whole platform, no user passed in');
  assert.doesNotMatch(source, /let admin\b|const admin = adminClient/, 'the owner flag and the database client have different names');
});

// ------------------------------- the real reason: for the platform owner only

test('provider failures carry the provider\'s status, message and address, but never a secret', async () => {
  const fetchImpl = mockFetch(reply({ error: { code: 'DeploymentNotFound', message: `The API deployment for this resource does not exist. key=${AZURE_SETTINGS.apiKey}` } }, 404));
  const model = createAzureFoundryModel({ endpoint: 'https://res.openai.azure.com', apiKey: AZURE_SETTINGS.apiKey, model: 'gpt-4o', fetchImpl });
  await assert.rejects(model.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.providerStatus, 404);
    assert.equal(error.requestUrl, OPENAI_STYLE('res.openai.azure.com', 'gpt-4o'));
    assert.match(error.detail, /DeploymentNotFound|deployment for this resource does not exist/);
    for (const text of [error.message, error.detail, error.requestUrl]) assert.ok(!text.includes(AZURE_SETTINGS.apiKey));
    return true;
  });

  const unauthorized = createAzureFoundryModel({ ...AZURE_SETTINGS, fetchImpl: mockFetch(reply({ error: { message: 'Access denied due to invalid subscription key.' } }, 401)) });
  await assert.rejects(unauthorized.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }), (error) => error.status === 503 && error.providerStatus === 401);

  const offline = createAzureFoundryModel({ ...AZURE_SETTINGS, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(offline.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }), (error) => error.status === 504 && error.providerStatus === null && error.detail === 'ENOTFOUND' && error.requestUrl.startsWith('https://my-resource.services.ai.azure.com/'));
});

test('the platform owner is shown the real error; coaches, trainers and clients only that Jack is unavailable', () => {
  const failure = new ModelError(502, 'The AI service returned an error.', 'The API deployment for this resource does not exist.', { providerStatus: 404, requestUrl: OPENAI_STYLE('res.openai.azure.com', 'gpt-4o') });
  const forOwner = describeJackFailure(failure, { admin: true });
  assert.equal(forOwner, `The AI service returned an error. (HTTP 404: The API deployment for this resource does not exist.) [${OPENAI_STYLE('res.openai.azure.com', 'gpt-4o')}]`);
  assert.equal(formatProviderFailure(new ModelError(504, 'The AI service did not respond in time.', 'ENOTFOUND')), 'The AI service did not respond in time. (no answer: ENOTFOUND)');

  for (const admin of [false, undefined]) {
    const text = describeJackFailure(failure, { admin });
    assert.equal(text, JACK_UNAVAILABLE);
    assert.ok(!/404|deployment|azure|openai/i.test(text));
  }
  assert.equal(describeJackFailure(failure), JACK_UNAVAILABLE, 'hidden unless the caller is proven to be the owner');
  assert.match(describeJackFailure(new ModelError(429, 'The AI service is busy. Try again in a moment.'), {}), /busy/);

  const notConfigured = new ConfigError('Jack is not configured. Set OPENAI_API_KEY…');
  assert.match(describeJackFailure(notConfigured, { admin: true }), /not configured/);
  assert.equal(describeJackFailure(notConfigured, { admin: false }), JACK_UNAVAILABLE);
  assert.match(describeJackFailure(new Error('boom'), { admin: true }), /boom/);
  assert.doesNotMatch(describeJackFailure(new Error('boom'), { admin: false }), /boom/);
});

test('Jack\'s route decides who is the owner from the verified session, and only that decides what is revealed', async () => {
  for (const route of ['jack', 'ai']) assert.equal(typeof (await import(`../api/${route}.js`)).default, 'function', `api/${route}.js loads`);
  const source = read('api/jack.js');
  assert.match(source, /const admin = isPlatformAdmin\(user\)/, 'the verified Supabase user, never the request body');
  assert.match(source, /describeJackFailure\(error, \{ admin \}\)/);
  assert.doesNotMatch(source, /body\.admin|request\.admin|access\.admin/);
  // The request parser ignores anything claiming to be an admin.
  const parsed = parseJackRequest({ messages: [{ role: 'user', content: 'hi' }], admin: true, isAdmin: true, role: 'super_admin' }, {});
  assert.ok(!('admin' in parsed) && !('isAdmin' in parsed) && !('role' in parsed));
});

test('Test connection tells the owner the provider\'s status and the address that failed', async () => {
  const store = memoryStore();
  const notFound = mockFetch(reply({ error: { message: 'Resource not found' } }, 404));
  const result = await request(store, { action: 'test', provider: 'azure_foundry', settings: { endpoint: 'https://res.openai.azure.com/openai/', model: 'gpt-4o', apiKey: AZURE_SETTINGS.apiKey } }, { fetchImpl: notFound });
  assert.deepEqual([result.body.ok, result.body.providerStatus, result.body.detail, result.body.requestUrl], [false, 404, 'Resource not found', OPENAI_STYLE('res.openai.azure.com', 'gpt-4o')]);
  assert.ok(!JSON.stringify(result.body).includes(AZURE_SETTINGS.apiKey));
  assert.equal(notFound.requests[0].url, OPENAI_STYLE('res.openai.azure.com', 'gpt-4o'), 'the cleaned address is the one that was called');
});

// -------------------------------------------------------------------- translations

const AI_KEY = /^(ai[A-Z_]|adminAi)/;

test('every language has the same AI settings texts', () => {
  const keysOf = (locale) => Object.keys(translations[locale]).filter((key) => AI_KEY.test(key)).sort();
  const english = keysOf('en');
  assert.ok(english.length >= 50);
  for (const locale of supportedLocales) {
    assert.deepEqual(keysOf(locale), english, locale);
    for (const key of english) assert.ok(String(translations[locale][key]).trim(), `${locale}.${key}`);
  }
});

test('every error key the validation can return, and every provider label, exists in all languages', () => {
  const errors = ['aiErrRequired', 'aiErrRegion', 'aiErrEndpoint', 'aiErrModel', 'aiErrProvider', 'aiErr_apiKey', 'aiErr_accessKeyId', 'aiErr_secretAccessKey', 'aiErr_sessionToken'];
  const labels = ['default', 'openai', 'gemini', 'bedrock', 'azure_foundry'].flatMap((provider) => [`aiProvider_${provider}`, ...(provider === 'default' ? [] : [`aiHint_${provider}`])]);
  const fields = ['apiKey', 'model', 'modelBedrock', 'modelAzure', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey', 'sessionToken'].map((field) => `aiField_${field}`);
  const admin = ['adminAiTitle', 'adminAiDescription', 'adminAiLink', 'adminAiLinkHelp', 'adminAiOpen', 'aiEveryoneNote'];
  for (const locale of supportedLocales) for (const key of [...errors, ...labels, ...fields, ...admin]) assert.ok(translations[locale][key], `${locale}.${key}`);
});
