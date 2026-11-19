import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { translations } from '../src/i18n/translations.js';
import {
  bankLines, emptyPaymentForm, formFromMethods, formatIban, ibanIsValid, invoiceStage, normalizeIban, paymentsReady, validatePaymentForm,
} from '../src/services/paymentMethodsUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Clients pay their coach directly: the coach states how, the client says "I paid", the coach confirms.

const MIGRATION = new URL('../supabase/migrations/20261115002400_manual_invoice_payments.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000a2',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
const GOOD_IBAN = 'DE89 3704 0044 0532 0130 00';
const GOOD_IBANS = ['DE89370400440532013000', 'GB82WEST12345698765432', 'FR1420041010050500013M02606', 'SA0380000000608010167519', 'AE070331234567890123456', 'EG380019000500000000263180002'];

// ------------------------------------------------------------------ IBAN and the form

test('IBANs are checked for shape and checksum, with spaces and case ignored', () => {
  for (const iban of GOOD_IBANS) assert.equal(ibanIsValid(iban), true, iban);
  assert.equal(ibanIsValid(GOOD_IBAN), true);
  assert.equal(ibanIsValid('de89-3704-0044-0532-0130-00'), true);
  for (const bad of ['DE89370400440532013001', 'DE88370400440532013000', 'XX', '', null, undefined, '12345678901234', 'DE89 3704', 'DE89370400440532013000EXTRA', 'GB82WEST1234569876543']) {
    assert.equal(ibanIsValid(bad), false, String(bad));
  }
  assert.equal(normalizeIban(' de89 3704-0044 '), 'DE8937040044');
  assert.equal(formatIban('DE89370400440532013000'), 'DE89 3704 0044 0532 0130 00');
});

test('the form is checked the way the database checks it, with translatable errors', () => {
  const empty = validatePaymentForm(emptyPaymentForm());
  assert.equal(empty.valid, true, 'nothing enabled is allowed');
  assert.equal(paymentsReady({ bank: null, custom: null }), false);

  const bank = validatePaymentForm({ ...emptyPaymentForm(), bankEnabled: true, holder: 'Amal Strength', iban: GOOD_IBAN, swift: 'cobadeffxxx' });
  assert.equal(bank.valid, true);
  assert.deepEqual([bank.payload.p_iban, bank.payload.p_swift_bic, bank.payload.p_bank_enabled, bank.payload.p_custom_enabled], ['DE89370400440532013000', 'COBADEFFXXX', true, false]);

  const needs = validatePaymentForm({ ...emptyPaymentForm(), bankEnabled: true });
  assert.deepEqual([needs.errors.holder, needs.errors.iban], ['payErrHolder', 'payErrBankNumber']);
  assert.equal(validatePaymentForm({ ...emptyPaymentForm(), bankEnabled: true, holder: 'Amal', accountNumber: '0123456789' }).valid, true);
  assert.equal(validatePaymentForm({ ...emptyPaymentForm(), bankEnabled: true, holder: 'Amal', iban: 'DE89370400440532013001' }).errors.iban, 'payErrIban');
  assert.equal(validatePaymentForm({ ...emptyPaymentForm(), bankEnabled: true, holder: 'Amal', iban: GOOD_IBAN, swift: 'BAD' }).errors.swift, 'payErrSwift');
  // A mistyped IBAN is caught even when bank transfer is switched off.
  assert.equal(validatePaymentForm({ ...emptyPaymentForm(), iban: 'DE00' }).errors.iban, 'payErrIban');

  const custom = validatePaymentForm({ ...emptyPaymentForm(), customEnabled: true, customLabel: 'InstaPay', customInstructions: 'Send to amal@instapay' });
  assert.equal(custom.valid, true);
  const missing = validatePaymentForm({ ...emptyPaymentForm(), customEnabled: true, customLabel: 'x' });
  assert.deepEqual([missing.errors.customLabel, missing.errors.customInstructions], ['payErrCustomLabel', 'payErrCustomText']);
  assert.equal(validatePaymentForm({ ...emptyPaymentForm(), note: 'x'.repeat(501) }).errors.note, 'payErrNote');
});

test('saved details come back as a form, and clients see only the lines that exist', () => {
  const methods = { bank: { account_holder: 'Amal', bank_name: '', iban: 'DE89370400440532013000', swift_bic: null, account_number: null }, custom: { label: 'InstaPay', instructions: 'Send it' }, note: 'Thanks' };
  const form = formFromMethods(methods);
  assert.deepEqual([form.bankEnabled, form.iban, form.customEnabled, form.customLabel, form.note], [true, 'DE89 3704 0044 0532 0130 00', true, 'InstaPay', 'Thanks']);
  assert.deepEqual(formFromMethods(null), emptyPaymentForm());
  assert.equal(paymentsReady(methods), true);
  assert.deepEqual(bankLines(methods.bank).map(([key]) => key), ['payAccountHolder', 'payIban']);
  assert.deepEqual(bankLines(null), []);
  assert.equal(invoiceStage({ status: 'open', payment_reported_at: '2026-11-18T10:00:00Z' }), 'reported');
  assert.equal(invoiceStage({ status: 'open', payment_reported_at: null }), 'open');
  assert.equal(invoiceStage({ status: 'paid', payment_reported_at: '2026-11-18T10:00:00Z' }), 'paid');
});

// ------------------------------------------------------------------ database

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function fails(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

const BANK = {
  p_bank_enabled: true, p_account_holder: 'Amal Strength', p_bank_name: 'Deutsche Bank', p_iban: GOOD_IBAN, p_swift_bic: 'cobadeffxxx',
  p_account_number: null, p_custom_enabled: false, p_custom_label: null, p_custom_instructions: null, p_payment_note: 'Quote the invoice number',
};
const save = (userId, overrides = {}) => as(userId).rpc('save_payment_methods', { ...BANK, ...overrides });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.other, email: 'nour@example.com', role: 'coach', fullName: 'Coach Nour' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara Ali' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client', fullName: 'Omar Ali' });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_email, client_name) values ($1, $2, 'sara@example.com', 'Sara Ali')", [ids.coach, ids.sara]);
  await db.query("insert into public.coach_clients (coach_id, client_id, client_email, client_name) values ($1, $2, 'omar@example.com', 'Omar Ali')", [ids.other, ids.omar]);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(migration);
});

test('the database accepts and rejects the same IBANs as the browser', async () => {
  for (const iban of [...GOOD_IBANS, GOOD_IBAN, 'de89-3704-0044-0532-0130-00']) {
    assert.equal((await rows('select public.iban_is_valid($1) as ok', [iban]))[0].ok, true, iban);
  }
  for (const bad of ['DE89370400440532013001', 'DE88370400440532013000', 'XX', '', '12345678901234', 'DE89 3704', 'DE89370400440532013000EXTRA']) {
    assert.equal((await rows('select public.iban_is_valid($1) as ok', [bad]))[0].ok, false, bad);
  }
  assert.equal((await rows('select public.iban_is_valid(null) as ok'))[0].ok, false);
});

test('a coach saves bank details and an agreed method, and they come back tidied', async () => {
  const saved = await ok(save(ids.coach, { p_custom_enabled: true, p_custom_label: 'InstaPay', p_custom_instructions: 'Send to amal@instapay' }));
  assert.deepEqual(saved.bank, { account_holder: 'Amal Strength', bank_name: 'Deutsche Bank', iban: 'DE89370400440532013000', swift_bic: 'COBADEFFXXX', account_number: null });
  assert.deepEqual(saved.custom, { label: 'InstaPay', instructions: 'Send to amal@instapay' });
  assert.equal(saved.note, 'Quote the invoice number');

  const mine = await ok(as(ids.coach).rpc('get_my_payment_methods'));
  assert.deepEqual(mine.bank, saved.bank);

  // Saving again replaces the details; switching a method off hides it.
  const bankOnly = await ok(save(ids.coach, { p_custom_enabled: false, p_bank_name: '' }));
  assert.equal(bankOnly.custom, null);
  assert.equal(bankOnly.bank.bank_name, null);
  assert.equal((await rows('select count(*)::int as n from public.coach_payment_methods'))[0].n, 1);

  const local = await ok(save(ids.other, { p_iban: null, p_swift_bic: null, p_account_number: '0123456789' }));
  assert.equal(local.bank.account_number, '0123456789');
});

test('wrong or incomplete payment details are refused', async () => {
  await fails(save(ids.coach, { p_iban: 'DE89370400440532013001' }), /IBAN is not valid/);
  await fails(save(ids.coach, { p_swift_bic: 'NOPE' }), /SWIFT/);
  await fails(save(ids.coach, { p_account_holder: '', p_iban: GOOD_IBAN }), /account holder/);
  await fails(save(ids.coach, { p_iban: null }), /IBAN or an account number/);
  await fails(save(ids.coach, { p_bank_enabled: false, p_custom_enabled: true, p_custom_label: 'x', p_custom_instructions: 'send it' }), /method name must be 2 to 60/);
  await fails(save(ids.coach, { p_bank_enabled: false, p_custom_enabled: true, p_custom_label: 'InstaPay', p_custom_instructions: '' }), /needs a name and instructions/);
  await fails(save(ids.coach, { p_payment_note: 'x'.repeat(501) }), /up to 500/);
  await fails(save(ids.coach, { p_account_holder: 'A' }), /2 to 120/);
  assert.equal((await rows('select count(*)::int as n from public.coach_payment_methods'))[0].n, 0);
  assert.ok((await db.query("select 1")).rows.length);
  await assert.rejects(db.query("insert into public.coach_payment_methods (coach_id, bank_enabled, iban, account_holder) values ($1, true, 'DE00', 'A B')", [ids.coach]), /iban_check|violates check/);
});

test('only coaches can set payment details, and nobody can write the table directly', async () => {
  await fails(save(ids.sara), /active coach/);
  await fails(as(ids.sara).rpc('get_my_payment_methods'), /active coach/);
  await ok(save(ids.coach));
  assert.ok((await as(ids.coach).sql("update public.coach_payment_methods set iban = 'GB82WEST12345698765432'")).error);
  assert.ok((await as(ids.coach).sql("insert into public.coach_payment_methods (coach_id) values ($1)", [ids.other])).error);
  assert.ok((await as(ids.sara).sql('select iban from public.coach_payment_methods')).rows.length === 0);
  assert.equal((await as(ids.other).sql('select coach_id from public.coach_payment_methods')).rows.length, 0, 'another coach cannot read it');
  assert.equal((await as(ids.coach).sql('select coach_id from public.coach_payment_methods')).rows.length, 1);
});

test('a client reads only their own coach\'s details, and only while they are an active client', async () => {
  await ok(save(ids.coach));
  await ok(save(ids.other, { p_account_holder: 'Nour Fit', p_iban: 'GB82WEST12345698765432' }));

  const info = await ok(as(ids.sara).rpc('get_coach_payment_info', { p_coach_id: ids.coach }));
  assert.equal(info.bank.iban, 'DE89370400440532013000');
  await fails(as(ids.sara).rpc('get_coach_payment_info', { p_coach_id: ids.other }), /not available/);
  await fails(as(ids.omar).rpc('get_coach_payment_info', { p_coach_id: ids.coach }), /not available/);
  await fails(as(ids.coach).rpc('get_coach_payment_info', { p_coach_id: ids.coach }), /client account/);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  await fails(as(ids.sara).rpc('get_coach_payment_info', { p_coach_id: ids.coach }), /not available/);
});

test('a coach with nothing set up shows clients empty instructions', async () => {
  assert.deepEqual(await ok(as(ids.sara).rpc('get_coach_payment_info', { p_coach_id: ids.coach })), { bank: null, custom: null, note: null });
  await ok(save(ids.coach, { p_bank_enabled: false }));
  assert.deepEqual(await ok(as(ids.sara).rpc('get_coach_payment_info', { p_coach_id: ids.coach })), { bank: null, custom: null, note: null });
});

// ------------------------------------------------------------------ invoices

const invoice = (userId, overrides = {}) => as(userId).rpc('create_invoice', {
  p_client_id: ids.sara, p_description: 'Monthly coaching', p_amount_cents: 12000, p_currency: 'usd', p_due_date: null, ...overrides,
});
const state = async (id) => (await rows('select status, paid_method, payment_reference, payment_reported_at, paid_at from public.invoices where id = $1', [id]))[0];

async function packageInvoice() {
  await db.query("insert into public.coach_packages (coach_id, name, session_count, price_cents, currency) values ($1, '10 sessions', 10, 50000, 'usd')", [ids.coach]);
  const [{ id }] = await rows('select id from public.coach_packages');
  return ok(as(ids.sara).rpc('create_package_invoice', { p_client_id: ids.sara, p_package_id: id }));
}

test('the client reports a payment and the coach confirms it', async () => {
  const id = await ok(invoice(ids.coach));
  await ok(as(ids.sara).rpc('report_invoice_payment', { p_invoice_id: id }));
  const reported = await state(id);
  assert.deepEqual([reported.status, reported.payment_reported_at !== null], ['open', true]);
  await ok(as(ids.sara).rpc('report_invoice_payment', { p_invoice_id: id }));

  const result = await ok(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'bank_transfer', p_reference: '  TRX 4471  ' }));
  assert.equal(result.status, 'paid');
  const paid = await state(id);
  assert.deepEqual([paid.status, paid.paid_method, paid.payment_reference, paid.paid_at !== null], ['paid', 'bank_transfer', 'TRX 4471', true]);
  assert.equal((await rows('select count(*)::int as n from public.client_package_credits'))[0].n, 0, 'a plain invoice gives no sessions');
});

test('confirming a package invoice gives the client their sessions once', async () => {
  const id = await packageInvoice();
  const result = await ok(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'cash', p_reference: null }));
  assert.equal(result.credits_added, 10);
  const [credit] = await rows('select * from public.client_package_credits');
  assert.deepEqual([credit.client_id, credit.sessions_total, credit.sessions_remaining, credit.package_name], [ids.sara, 10, 10, '10 sessions']);
  await fails(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'cash' }), /Only open invoices/);
  assert.equal((await rows('select count(*)::int as n from public.client_package_credits'))[0].n, 1);
});

test('nobody else can report or confirm an invoice', async () => {
  const id = await ok(invoice(ids.coach));
  await fails(as(ids.omar).rpc('report_invoice_payment', { p_invoice_id: id }), /own open invoices/);
  await fails(as(ids.coach).rpc('report_invoice_payment', { p_invoice_id: id }), /client account/);
  await fails(as(ids.sara).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'cash' }), /active coach/);
  await fails(as(ids.other).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'cash' }), /not found/);
  await fails(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'bitcoin' }), /how the invoice was paid/);
  await fails(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'cash', p_reference: 'x'.repeat(121) }), /too long/);
  assert.equal((await state(id)).status, 'open');
  assert.ok((await as(ids.sara).sql("update public.invoices set status = 'paid'")).error, 'a client cannot mark an invoice paid');
  assert.ok((await as(ids.coach).sql("update public.invoices set status = 'paid'")).error, 'a coach changes invoices only through the functions');
});

test('a voided or paid invoice can neither be reported nor confirmed', async () => {
  const id = await ok(invoice(ids.coach));
  await ok(as(ids.coach).rpc('void_invoice', { p_invoice_id: id }));
  await fails(as(ids.sara).rpc('report_invoice_payment', { p_invoice_id: id }), /own open invoices/);
  await fails(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: id, p_method: 'cash' }), /Only open invoices/);
});

test('the payment details of one coach never reach another coach\'s clients through invoices', async () => {
  await ok(save(ids.coach));
  const id = await ok(invoice(ids.coach));
  const seen = await ok(as(ids.sara).from('invoices').select('id,coach_id,payment_reported_at,paid_method'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].coach_id, ids.coach);
  assert.equal((await ok(as(ids.omar).from('invoices').select('id'))).length, 0);
  assert.ok(id);
});

// ------------------------------------------------------------------ texts

test('every new payment text exists in all five languages with the same placeholders', () => {
  const keys = Object.keys(translations.en).filter((key) => /^(pay[A-Z]|invoice_(reported|waiting)|confirmPayment|paidVia|paymentReference|howToPay|invoiceMarkedPaid)/.test(key));
  assert.ok(keys.length >= 55, `${keys.length} keys`);
  for (const key of keys) for (const locale of ['ar', 'de', 'fr', 'es']) assert.ok(translations[locale][key], `${locale}.${key}`);
  for (const gone of ['stripeConnect', 'stripeContinueOnboarding', 'stripeConnectError', 'stripeUnavailable', 'paymentsHelp', 'payNow', 'checkoutError', 'checkoutSuccess', 'checkoutCanceled']) {
    assert.equal(gone in translations.en, false, gone);
  }
  assert.doesNotMatch(translations.en.invoicingDescription, /Stripe/);
  for (const locale of ['en', 'ar', 'de', 'fr', 'es']) assert.doesNotMatch(translations[locale].invoicingDescription, /Stripe/, locale);
});

test('no code, setting or screen text mentions Stripe any more', () => {
  const root = new URL('../', import.meta.url);
  const hits = [];
  const visit = (relative) => {
    const url = new URL(relative, root);
    if (!existsSync(url)) return;
    if (statSync(url).isDirectory()) {
      for (const name of readdirSync(url)) visit(`${relative.replace(/\/$/, '')}/${name}`);
    } else if (/\.(js|jsx|mjs|json|html|example)$/.test(relative) && /stripe/i.test(readFileSync(url, 'utf8'))) {
      hits.push(relative);
    }
  };
  for (const entry of ['api', 'src', 'scripts', 'package.json', 'vercel.json', 'index.html', '.env.example']) visit(entry);
  assert.deepEqual(hits, []);
  assert.equal(existsSync(new URL('api/stripe.js', root)) || existsSync(new URL('api/stripe-webhook.js', root)) || existsSync(new URL('api/store.js', root)), false);
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  assert.equal(Object.keys(lock.packages).some((name) => /(^|\/)stripe$/.test(name)), false, 'the stripe package is gone');
  for (const locale of ['en', 'ar', 'de', 'fr', 'es']) {
    assert.equal(Object.values(translations[locale]).some((text) => /stripe/i.test(text)), false, locale);
  }
});

test('the database keeps no Stripe tables, columns or functions', async () => {
  const tables = await rows("select table_name, column_name from information_schema.columns where table_schema = 'public' and (table_name ilike '%stripe%' or column_name ilike '%stripe%')");
  assert.deepEqual(tables, []);
  assert.deepEqual(await rows("select table_name from information_schema.tables where table_schema = 'public' and table_name = 'coach_payment_accounts'"), []);
  assert.deepEqual(await rows("select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('mark_invoice_paid', 'complete_store_order', 'finish_store_order')"), []);
  assert.deepEqual((await rows("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'store_orders_payment_mode_check'")).map((row) => /stripe|demo/.test(row.def)), [false]);
});

test('a project that sold through Stripe keeps its paid orders and invoices when the cleanup runs', async () => {
  const STORE_MIGRATION = new URL('../supabase/migrations/20261115002500_store_direct_payments.sql', import.meta.url);
  // Put the old shape back: the Stripe columns and table, the old payment modes, and orders and invoices paid that way.
  await db.exec(`
    alter table public.store_orders drop constraint store_orders_payment_mode_check;
    alter table public.store_orders add column stripe_session_id text, add column stripe_payment_intent_id text;
    alter table public.invoices add column stripe_checkout_session_id text, add column stripe_payment_intent_id text;
    create table public.coach_payment_accounts (coach_id uuid primary key, stripe_account_id text not null);
  `);
  await db.query(
    `insert into public.store_orders (buyer_client_id, coach_id, product_title, amount_cents, currency, status, payment_mode, stripe_session_id, purchased_at)
     values ($1, $2, 'Old plan', 2900, 'usd', 'paid', 'stripe', 'cs_1', now()), ($1, $2, 'Test plan', 100, 'usd', 'paid', 'demo', null, now())`,
    [ids.sara, ids.coach],
  );
  await db.query(
    "insert into public.invoices (invoice_number, coach_id, client_id, description, amount_cents, currency, status, paid_at, stripe_checkout_session_id) values ('INV-OLD1', $1, $2, 'Old', 9000, 'usd', 'paid', now(), 'cs_9')",
    [ids.coach, ids.sara],
  );

  await db.exec(readFileSync(STORE_MIGRATION, 'utf8'));

  assert.deepEqual(
    (await rows("select product_title, status, payment_mode, paid_method from public.store_orders order by product_title")).map((row) => [row.product_title, row.status, row.payment_mode, row.paid_method]),
    [['Old plan', 'paid', 'manual', 'card'], ['Test plan', 'paid', 'manual', 'other']],
  );
  assert.deepEqual((await rows("select status, paid_method from public.invoices where invoice_number = 'INV-OLD1'"))[0], { status: 'paid', paid_method: 'card' });
  assert.deepEqual(await rows("select column_name from information_schema.columns where table_schema = 'public' and column_name ilike '%stripe%'"), []);
  assert.deepEqual(await rows("select 1 from information_schema.tables where table_schema = 'public' and table_name = 'coach_payment_accounts'"), []);
  // The buyer keeps the order they paid for.
  assert.deepEqual((await ok(as(ids.sara).rpc('get_my_store'))).purchases.map((purchase) => purchase.title).sort(), ['Old plan', 'Test plan']);
});
