import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import unsubscribe from '../api/unsubscribe.js';
import { ConfigError } from '../api/_lib/config.js';
import {
  buildUnsubscribeUrl, emailConfig, isEmailConfigured, sendCampaignBatch, sendEmailViaResend, senderAddress, signUnsubscribe, verifyUnsubscribe,
} from '../api/_lib/emailCampaign.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  CAMPAIGN_LANGUAGES, campaignProgress, escapeHtml, fillVariables, firstName, isRtlLanguage, renderCampaignEmail, runCampaignSend, validateCampaignDraft,
} from '../src/services/campaignTemplate.js';
import { PAGES, navigationFor } from '../src/routes.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const MIGRATION = new URL('../supabase/migrations/20261115002700_email_campaigns.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  noMail: '00000000-0000-4000-8000-0000000000c3',
  bFan: '00000000-0000-4000-8000-0000000000c4',
};

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const create = (userId, overrides = {}) => as(userId).rpc('create_email_campaign', {
  p_subject: 'Spring offer', p_body: 'Hi {{client_name}}', p_language: 'en', p_client_ids: null, p_send_to_all: true, ...overrides,
});

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.noMail, 'x@example.com'], [ids.bFan, 'b@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email) values
       ($1, $2, 'Sara Ali', 'sara@example.com'), ($1, $3, 'Omar Hassan', 'omar@example.com'), ($1, $4, 'No Mail', '   '),
       ($5, $6, 'Bea Fan', 'b@example.com')`,
    [ids.coach, ids.sara, ids.omar, ids.noMail, ids.other, ids.bFan],
  );
});

// ------------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assert.equal((await rows("select column_default from information_schema.columns where table_name = 'profiles' and column_name = 'email_marketing_opt_out'"))[0].column_default, 'false');
});

test('a campaign to all clients lists everyone, skips people without an email and never reaches another coach\'s clients', async () => {
  const { data, error } = await create(ids.coach);
  assert.equal(error, null, error?.message);
  assert.equal(data.total_count, 3);
  assert.equal(data.skipped_count, 1);
  assert.equal(data.status, 'sending');
  const recipients = await rows('select client_id, status from public.email_campaign_recipients order by client_name');
  assert.deepEqual(recipients.map((row) => row.status).sort(), ['pending', 'pending', 'skipped_no_email']);
  assert.ok(!recipients.some((row) => row.client_id === ids.bFan));
});

test('selected recipients must be the coach\'s own active clients', async () => {
  const ok = await create(ids.coach, { p_send_to_all: false, p_client_ids: [ids.sara] });
  assert.equal(ok.error, null, ok.error?.message);
  assert.equal(ok.data.total_count, 1);
  assert.match((await create(ids.coach, { p_send_to_all: false, p_client_ids: [ids.sara, ids.bFan] })).error.message, /not your active clients/);
  assert.match((await create(ids.coach, { p_send_to_all: false, p_client_ids: null })).error.message, /at least one client/);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.omar]);
  assert.match((await create(ids.coach, { p_send_to_all: false, p_client_ids: [ids.omar] })).error.message, /no active clients|not your active/);
});

test('clients and coaches without a plan cannot create campaigns, and bad input is refused', async () => {
  assert.ok((await create(ids.sara)).error);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coach]);
  assert.match((await create(ids.coach)).error.message, /active coach plan/);
  await db.query("update public.profiles set trial_started_at = now(), trial_ends_at = now() + interval '72 hours' where id = $1", [ids.coach]);
  assert.match((await create(ids.coach, { p_subject: '  ' })).error.message, /subject/);
  assert.match((await create(ids.coach, { p_body: 'x'.repeat(5001) })).error.message, /5000/);
  assert.match((await create(ids.coach, { p_language: 'xx' })).error.message, /supported language/);
});

test('a coach can create at most 10 campaigns an hour', async () => {
  for (let index = 0; index < 10; index += 1) assert.equal((await create(ids.coach)).error, null);
  assert.match((await create(ids.coach)).error.message, /many campaigns/);
});

test('sending in batches records each result and closes the campaign as sent, partly sent or failed', async () => {
  const campaign = (await create(ids.coach)).data;
  const coach = as(ids.coach);

  const first = (await coach.rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id, p_limit: 1 })).data;
  assert.equal(first.recipients.length, 1);
  assert.equal(first.remaining, 1);
  assert.equal(first.campaign.coach_name, 'Amal Strength');
  assert.equal(first.campaign.subject, 'Spring offer');
  const second = (await coach.rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id, p_limit: 10 })).data;
  assert.equal(second.recipients.length, 1);
  assert.equal(second.remaining, 0);
  assert.notEqual(first.recipients[0].id, second.recipients[0].id);
  assert.equal((await coach.rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data.recipients.length, 0);

  assert.equal((await coach.rpc('record_email_campaign_result', { p_recipient_id: first.recipients[0].id, p_ok: true })).error, null);
  assert.equal((await rows('select status from public.email_campaigns'))[0].status, 'sending');
  await coach.rpc('record_email_campaign_result', { p_recipient_id: second.recipients[0].id, p_ok: false, p_error: 'Mailbox full' });
  const [done] = await rows('select status, sent_count, failed_count, skipped_count, completed_at from public.email_campaigns');
  assert.deepEqual([done.status, done.sent_count, done.failed_count, done.skipped_count], ['partial', 1, 1, 1]);
  assert.ok(done.completed_at);

  assert.equal((await coach.rpc('retry_failed_email_recipients', { p_campaign_id: campaign.id })).data, 1);
  assert.equal((await rows('select status from public.email_campaigns'))[0].status, 'sending');
  const retry = (await coach.rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data;
  await coach.rpc('record_email_campaign_result', { p_recipient_id: retry.recipients[0].id, p_ok: true });
  assert.equal((await rows('select status from public.email_campaigns'))[0].status, 'sent');
});

test('a campaign where every email fails ends as failed', async () => {
  const campaign = (await create(ids.coach, { p_send_to_all: false, p_client_ids: [ids.sara] })).data;
  const batch = (await as(ids.coach).rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data;
  await as(ids.coach).rpc('record_email_campaign_result', { p_recipient_id: batch.recipients[0].id, p_ok: false, p_error: 'x'.repeat(500) });
  const [row] = await rows('select status from public.email_campaigns');
  assert.equal(row.status, 'failed');
  assert.equal((await rows('select length(error) as n from public.email_campaign_recipients where status = $1', ['failed']))[0].n, 300);
});

test('a client who unsubscribes is skipped, even after the campaign was created', async () => {
  const campaign = (await create(ids.coach)).data;
  const saved = await as(ids.omar).rpc('set_my_email_marketing_opt_out', { p_opt_out: true });
  assert.equal(saved.data.email_marketing_opt_out, true);
  assert.equal((await as(ids.omar).rpc('get_my_email_preferences')).data.email_marketing_opt_out, true);
  const batch = (await as(ids.coach).rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data;
  assert.deepEqual(batch.recipients.map((row) => row.client_id), [ids.sara]);
  assert.equal((await rows("select count(*)::int as n from public.email_campaign_recipients where status = 'skipped_opt_out'"))[0].n, 1);

  const later = (await create(ids.coach)).data;
  assert.equal(later.skipped_count, 2);
  await as(ids.omar).rpc('set_my_email_marketing_opt_out', { p_opt_out: false });
  assert.equal((await as(ids.omar).rpc('get_my_email_preferences')).data.email_marketing_opt_out, false);
});

test('another coach cannot read, claim or record anything of this campaign, and nobody can write the tables directly', async () => {
  const campaign = (await create(ids.coach)).data;
  const batch = (await as(ids.coach).rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data;
  const intruder = as(ids.other);
  assert.match((await intruder.rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).error.message, /not found/);
  assert.match((await intruder.rpc('record_email_campaign_result', { p_recipient_id: batch.recipients[0].id, p_ok: true })).error.message, /not found/);
  assert.match((await intruder.rpc('retry_failed_email_recipients', { p_campaign_id: campaign.id })).error.message, /not found/);
  assert.deepEqual((await intruder.from('email_campaigns').select('id')).data, []);
  assert.deepEqual((await intruder.from('email_campaign_recipients').select('id')).data, []);
  assert.equal((await as(ids.coach).from('email_campaigns').select('id')).data.length, 1);
  assert.equal((await as(ids.coach).from('email_campaign_recipients').select('id')).data.length, 3);
  assert.deepEqual((await as(ids.sara).from('email_campaigns').select('id')).data, []);

  assert.ok((await as(ids.coach).sql("update public.email_campaigns set sent_count = 99")).error);
  assert.ok((await as(ids.coach).sql("update public.email_campaign_recipients set status = 'sent'")).error);
  assert.ok((await as(ids.coach).sql("update public.profiles set email_marketing_opt_out = true")).error);
  assert.ok((await as(ids.coach).rpc('email_campaign_refresh', { p_campaign_id: campaign.id })).error);
});

test('a recipient left "sending" by a stopped server is offered again after five minutes', async () => {
  const campaign = (await create(ids.coach, { p_send_to_all: false, p_client_ids: [ids.sara] })).data;
  const first = (await as(ids.coach).rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data;
  assert.equal(first.recipients.length, 1);
  assert.equal((await as(ids.coach).rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data.recipients.length, 0);
  await db.query("update public.email_campaign_recipients set claimed_at = now() - interval '6 minutes'");
  assert.equal((await as(ids.coach).rpc('claim_email_campaign_batch', { p_campaign_id: campaign.id })).data.recipients.length, 1);
});

// ----------------------------------------------------------------------------------------------- the email

test('the email is built in the chosen language and direction with the coach\'s variables', () => {
  const english = renderCampaignEmail({ subject: 'Hello {{ Client_Name }}', body: 'Hi {{client_name}},\n\nFrom {{coach_name}}.\nSee you!', language: 'en', clientName: 'Sara Ali', coachName: 'Amal', unsubscribeUrl: 'https://app.example/api/unsubscribe?u=1&t=2' });
  assert.equal(english.subject, 'Hello Sara');
  assert.equal(english.dir, 'ltr');
  assert.match(english.html, /dir="ltr"/);
  assert.match(english.html, /<p[^>]*>Hi Sara,<\/p><p[^>]*>From Amal\.<br>See you!<\/p>/);
  assert.match(english.html, /href="https:\/\/app\.example\/api\/unsubscribe\?u=1&amp;t=2"/);
  assert.match(english.text, /Unsubscribe from these emails: https:\/\/app\.example/);

  const arabic = renderCampaignEmail({ subject: 'عرض', body: 'مرحبا {{client_name}}', language: 'ar', clientName: '', coachName: 'أمل', unsubscribeUrl: 'https://x.example/u' });
  assert.equal(arabic.dir, 'rtl');
  assert.match(arabic.html, /dir="rtl"/);
  assert.match(arabic.html, /text-align:right/);
  assert.match(arabic.html, /مرحبا عزيزي المتدرب/);
  assert.match(arabic.html, /إلغاء الاشتراك/);
  assert.equal(isRtlLanguage('ar'), true);
  assert.equal(isRtlLanguage('en'), false);
});

test('the coach\'s text can never inject markup, and unknown variables disappear', () => {
  const email = renderCampaignEmail({ subject: 'A\r\nBcc: x@evil.test', body: '<script>alert(1)</script> {{secret}} {{client_name}}', language: 'fr', clientName: '<b>Eve</b>', coachName: 'C', unsubscribeUrl: 'https://u.example' });
  assert.doesNotMatch(email.subject, /[\r\n]/);
  assert.doesNotMatch(email.html, /<script>|<b>Eve/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.html, /secret/);
  assert.equal(escapeHtml(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(fillVariables('{{client_name}}|{{x}}', { client_name: 'A' }), 'A|');
  assert.equal(firstName('  Sara  Ali '), 'Sara');
  assert.equal(firstName(null), '');
});

test('drafts are validated before anything is created', () => {
  assert.equal(validateCampaignDraft({ subject: 'Hi', body: 'Text', language: 'ar' }).valid, true);
  assert.deepEqual(validateCampaignDraft({ subject: ' ', body: '', language: 'xx' }).errors, { subject: 'campaignErrSubject', body: 'campaignErrBody', language: 'campaignErrLanguage' });
  assert.equal(validateCampaignDraft({ subject: 'x'.repeat(151), body: 'y', language: 'en' }).errors.subject, 'campaignErrSubjectLong');
  assert.equal(validateCampaignDraft({ subject: 'x', body: 'y'.repeat(5001), language: 'en' }).errors.body, 'campaignErrBodyLong');
  assert.deepEqual(campaignProgress({ total_count: 4, sent_count: 1, failed_count: 1, skipped_count: 0 }), { total: 4, done: 2, percent: 50 });
  assert.equal(campaignProgress({}).percent, 0);
});

test('the browser keeps sending batches until nobody is left, and stops on a batch that did nothing', async () => {
  const answers = [{ sent: 10, failed: 0, remaining: 5 }, { sent: 4, failed: 1, remaining: 0 }];
  const seen = [];
  const result = await runCampaignSend(async () => answers.shift(), 'c1', { onProgress: (progress) => seen.push(progress.remaining) });
  assert.deepEqual(result, { sent: 14, failed: 1, remaining: 0, stopped: false });
  assert.deepEqual(seen, [5, 0]);
  assert.deepEqual(await runCampaignSend(async () => ({ sent: 0, failed: 0, remaining: 3 }), 'c1'), { sent: 0, failed: 0, remaining: 3, stopped: true });
  await assert.rejects(runCampaignSend(async () => { throw new Error('offline'); }, 'c1'), /offline/);
  assert.equal((await runCampaignSend(async () => ({ sent: 1, failed: 0, remaining: 1 }), 'c1', { shouldStop: () => true })).stopped, true);
});

// ------------------------------------------------------------------------------------------------ the server

const SECRET = 'test-secret-with-enough-length';
const config = { apiKey: 're_test', from: 'ApexFit <hello@apex.example>', secret: SECRET, baseUrl: 'https://app.example' };
const claimed = (people) => ({
  campaign: { id: 'c', subject: 'Hello {{client_name}}', body: 'Body', language: 'ar', coach_name: 'Amal' },
  recipients: people.map((email, index) => ({ id: `r${index}`, client_id: `00000000-0000-4000-8000-00000000000${index}`, email, name: `Client ${index}` })),
  remaining: 7,
});

test('unsubscribe links are signed per client and cannot be forged', () => {
  const token = signUnsubscribe(ids.sara, SECRET);
  assert.equal(verifyUnsubscribe(ids.sara, token, SECRET), true);
  assert.equal(verifyUnsubscribe(ids.omar, token, SECRET), false);
  assert.equal(verifyUnsubscribe(ids.sara, token, 'another-secret'), false);
  assert.equal(verifyUnsubscribe(ids.sara, `${token}x`, SECRET), false);
  assert.equal(verifyUnsubscribe(ids.sara, '', SECRET), false);
  const url = new URL(buildUnsubscribeUrl('https://app.example', ids.sara, 'ar', SECRET));
  assert.equal(url.pathname, '/api/unsubscribe');
  assert.equal(url.searchParams.get('u'), ids.sara);
  assert.equal(url.searchParams.get('l'), 'ar');
  assert.ok(verifyUnsubscribe(url.searchParams.get('u'), url.searchParams.get('t'), SECRET));
});

test('one bad email does not stop the others, and each result is recorded', async () => {
  const recorded = [];
  const sentTo = [];
  const result = await sendCampaignBatch({
    claimed: claimed(['a@x.test', 'bad@x.test', 'c@x.test']),
    config,
    replyTo: 'coach@x.test',
    retryDelayMs: 1,
    send: async (message) => {
      if (message.to === 'bad@x.test') throw Object.assign(new Error('Invalid address'), { retryable: false });
      sentTo.push(message);
    },
    record: async (id, ok, error) => { recorded.push([id, ok, error]); },
  });
  assert.deepEqual(result, { sent: 2, failed: 1, remaining: 7 });
  assert.deepEqual(recorded.sort((a, b) => a[0].localeCompare(b[0])), [['r0', true, null], ['r1', false, 'Invalid address'], ['r2', true, null]]);
  const message = sentTo[0];
  assert.equal(message.from, 'Amal <hello@apex.example>');
  assert.equal(message.replyTo, 'coach@x.test');
  assert.equal(message.subject, 'Hello Client');
  assert.match(message.html, /dir="rtl"/);
  assert.match(message.headers['List-Unsubscribe'], /^<https:\/\/app\.example\/api\/unsubscribe\?/);
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('a rate-limited or failing provider is retried once, then reported for that recipient only', async () => {
  let attempts = 0;
  const flaky = async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('Too many requests'), { retryable: true }); };
  const ok = await sendCampaignBatch({ claimed: claimed(['a@x.test']), config, send: flaky, record: async () => {}, retryDelayMs: 1 });
  assert.deepEqual([ok.sent, ok.failed, attempts], [1, 0, 2]);

  attempts = 0;
  const always = async () => { attempts += 1; throw Object.assign(new Error('Provider down'), { retryable: true }); };
  const recorded = [];
  const bad = await sendCampaignBatch({ claimed: claimed(['a@x.test']), config, send: always, record: async (...args) => { recorded.push(args); }, retryDelayMs: 1 });
  assert.deepEqual([bad.sent, bad.failed, attempts], [0, 1, 2]);
  assert.deepEqual(recorded, [['r0', false, 'Provider down']]);
});

test('Resend is called with the key in a header only, and failures say whether they can be retried', async () => {
  let call;
  const okFetch = async (url, options) => { call = { url, options }; return { ok: true, status: 200, json: async () => ({ id: 'em_1' }) }; };
  const sent = await sendEmailViaResend({ apiKey: 're_secret', from: 'A <a@x.test>', to: 'b@x.test', replyTo: 'c@x.test', subject: 'S', html: '<p>h</p>', text: 't', headers: { 'X-A': '1' } }, { fetchImpl: okFetch });
  assert.equal(sent.id, 'em_1');
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.options.headers.Authorization, 'Bearer re_secret');
  assert.doesNotMatch(call.options.body, /re_secret/);
  const payload = JSON.parse(call.options.body);
  assert.deepEqual([payload.to, payload.reply_to], [['b@x.test'], 'c@x.test']);

  const failWith = (status, message) => async () => ({ ok: false, status, json: async () => ({ message }) });
  await assert.rejects(sendEmailViaResend({ to: 'x' }, { fetchImpl: failWith(429, 'Slow down') }), { message: 'Slow down', retryable: true });
  await assert.rejects(sendEmailViaResend({ to: 'x' }, { fetchImpl: failWith(422, 'Bad address') }), { message: 'Bad address', retryable: false });
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(sendEmailViaResend({ to: 'x' }, { fetchImpl: hang, timeoutMs: 20 }), { retryable: true, message: /too long/ });
});

test('the sender shows the coach\'s name on the verified address', () => {
  assert.equal(senderAddress('ApexFit <hello@apex.example>', 'Coach "Amal" <x>'), 'Coach Amal x <hello@apex.example>');
  assert.equal(senderAddress('hello@apex.example', ''), 'ApexFit <hello@apex.example>');
});

test('missing email settings are reported as a configuration problem, not a crash', () => {
  assert.throws(() => emailConfig({}), ConfigError);
  assert.throws(() => emailConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.test' }), /EMAIL_UNSUBSCRIBE_SECRET/);
  assert.throws(() => emailConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.test', TOKEN_ENCRYPTION_KEY: 's' }), /APP_URL/);
  const ok = emailConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.test', TOKEN_ENCRYPTION_KEY: 's', APP_URL: 'https://app.example/' });
  assert.deepEqual([ok.apiKey, ok.secret, ok.baseUrl], ['k', 's', 'https://app.example']);
  assert.equal(isEmailConfigured({ RESEND_API_KEY: 'k' }), false);
  assert.equal(isEmailConfigured({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.test' }), true);
});

function fakeResponse() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (value) => { res.body = value; return res; };
  res.json = (value) => { res.body = JSON.stringify(value); return res; };
  return res;
}

test('the unsubscribe page confirms first, refuses bad links and speaks the email\'s language', async () => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = SECRET;
  try {
    const token = signUnsubscribe(ids.sara, SECRET);
    const page = fakeResponse();
    await unsubscribe({ method: 'GET', query: { u: ids.sara, t: token, l: 'ar' }, headers: {} }, page);
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['Content-Type'], /text\/html/);
    assert.match(page.body, /dir="rtl"/);
    assert.match(page.body, /<form method="post"/);

    const forged = fakeResponse();
    await unsubscribe({ method: 'GET', query: { u: ids.sara, t: 'nope', l: 'en' }, headers: {} }, forged);
    assert.equal(forged.statusCode, 400);
    assert.match(forged.body, /not valid/);
    const post = fakeResponse();
    await unsubscribe({ method: 'POST', query: { u: ids.sara, t: 'nope' }, body: 'List-Unsubscribe=One-Click', headers: {} }, post);
    assert.equal(post.statusCode, 400);
  } finally {
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  }
});

test('the sending endpoint checks the coach, keeps the provider key on the server and the page is in the coach menu', () => {
  const endpoint = readFileSync(new URL('../api/send-campaign.js', import.meta.url), 'utf8');
  assert.match(endpoint, /authenticate\(req\)/);
  assert.match(endpoint, /requireRole\(userClient, 'coach'\)/);
  assert.match(endpoint, /createRateLimiter/);
  assert.match(endpoint, /claim_email_campaign_batch/);
  const clientSide = ['../src/services/campaignService.js', '../src/pages/CampaignsPage.jsx', '../src/components/EmailPreferences.jsx', '../src/services/campaignTemplate.js']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(clientSide, /RESEND|api\.resend\.com|import\.meta\.env/);
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^RESEND_API_KEY=/m);
  assert.match(env, /^EMAIL_FROM=/m);
  assert.doesNotMatch(env, /VITE_[A-Z_]*(RESEND|EMAIL)/);
  assert.ok(navigationFor('coach').some(({ items }) => items.includes('campaigns')));
  assert.equal(PAGES.campaigns.access, 'coach');
});

test('every language has the campaign texts', () => {
  const keys = Object.keys(translations.en).filter((key) => /^(campaign|emailPref|navCampaigns)/.test(key));
  assert.ok(keys.length > 40);
  for (const locale of supportedLocales) for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
  for (const status of ['sending', 'sent', 'partial', 'failed']) assert.ok(translations.ar[`campaignStatus_${status}`]);
  assert.deepEqual(CAMPAIGN_LANGUAGES, supportedLocales);
  assert.match(translations.ar.campaignsTitle, /[\u0600-\u06FF]/);
});
