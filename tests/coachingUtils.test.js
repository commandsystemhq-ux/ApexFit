import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_BYTES,
  clientLabel,
  formatMoney,
  groupSentMessages,
  isUpcoming,
  normalizeInvoiceForm,
  normalizeMessageDraft,
  normalizePackageForm,
  normalizeSessionForm,
  parseMoneyToCents,
  totalCreditsRemaining,
  urlBase64ToUint8Array,
  validateVideoFile,
} from '../src/services/coachingUtils.js';

test('video attachments are limited to supported formats and 50 MB', () => {
  assert.equal(validateVideoFile({ type: 'video/mp4', size: 1024 }), 'mp4');
  assert.equal(validateVideoFile({ type: 'video/quicktime', size: MAX_VIDEO_BYTES }), 'mov');
  assert.throws(() => validateVideoFile({ type: 'video/avi', size: 10 }), /MP4, WebM, or MOV/);
  assert.throws(() => validateVideoFile({ type: 'video/mp4', size: MAX_VIDEO_BYTES + 1 }), /50 MB/);
});

test('message drafts need content and a clear audience', () => {
  assert.deepEqual(normalizeMessageDraft({ body: '  Hi  ', sendToAll: true, clientIds: ['a'] }), { body: 'Hi', sendToAll: true, clientIds: [] });
  assert.deepEqual(normalizeMessageDraft({ body: 'Hi', clientIds: ['a', 'a', 'b'] }).clientIds, ['a', 'b']);
  assert.doesNotThrow(() => normalizeMessageDraft({ videoFile: { type: 'video/webm', size: 5 }, sendToAll: true }));
  assert.throws(() => normalizeMessageDraft({ body: ' ', sendToAll: true }), /Write a message/);
  assert.throws(() => normalizeMessageDraft({ body: 'Hi' }), /at least one client/);
  assert.throws(() => normalizeMessageDraft({ body: 'x'.repeat(2001), sendToAll: true }), /2000/);
});

test('money parsing never uses floating point and enforces bounds', () => {
  assert.equal(parseMoneyToCents('49.99'), 4999);
  assert.equal(parseMoneyToCents('450'), 45000);
  assert.equal(parseMoneyToCents('0,5'), 50);
  assert.equal(parseMoneyToCents('19.9'), 1990);
  assert.equal(parseMoneyToCents('1.15'), 115);
  assert.throws(() => parseMoneyToCents('0.49'), /between 0.50/);
  assert.throws(() => parseMoneyToCents('12.345'), /Enter an amount/);
  assert.throws(() => parseMoneyToCents('abc'), /Enter an amount/);
  assert.throws(() => parseMoneyToCents('1000000.01'), /between 0.50/);
});

test('package and invoice forms are normalized', () => {
  assert.deepEqual(normalizePackageForm({ name: ' 10 sessions ', description: '', session_count: '10', price: '450.00', currency: 'eur' }), {
    name: '10 sessions', description: '', session_count: 10, price_cents: 45000, currency: 'eur',
  });
  assert.throws(() => normalizePackageForm({ name: 'x', session_count: '0', price: '10' }), /between 1 and 500/);
  assert.throws(() => normalizePackageForm({ name: 'x', session_count: '1', price: '10', currency: 'xyz' }), /supported currency/);
  assert.deepEqual(normalizeInvoiceForm({ description: 'Review', amount: '25', currency: 'usd', dueDate: '' }), {
    description: 'Review', amountCents: 2500, currency: 'usd', dueDate: null,
  });
  assert.equal(formatMoney(4999, 'usd', 'en'), '$49.99');
});

test('session forms validate time ordering and duration', () => {
  const base = { clientId: 'c', title: 'PT', date: '2026-12-01', startTime: '09:00', endTime: '10:00' };
  const session = normalizeSessionForm(base);
  assert.equal(new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime(), 3600000);
  assert.throws(() => normalizeSessionForm({ ...base, endTime: '09:00' }), /end after it starts/);
  assert.throws(() => normalizeSessionForm({ ...base, startTime: '01:00', endTime: '14:00' }), /12 hours/);
  assert.throws(() => normalizeSessionForm({ ...base, clientId: '' }), /Choose a client/);
  assert.throws(() => normalizeSessionForm({ ...base, date: '' }), /valid date/);
});

test('bulk message history groups recipients per batch', () => {
  const batches = groupSentMessages([
    { batch_id: 'b1', kind: 'note', body: 'a', video_path: null, created_at: '2026-01-01T10:00:00Z', read_at: '2026-01-01T11:00:00Z' },
    { batch_id: 'b1', kind: 'note', body: 'a', video_path: null, created_at: '2026-01-01T10:00:00Z', read_at: null },
    { batch_id: 'b2', kind: 'video', body: '', video_path: 'p', created_at: '2026-01-02T10:00:00Z', read_at: null },
  ]);
  assert.deepEqual(batches.map((batch) => [batch.batchId, batch.recipients, batch.read]), [['b2', 1, 0], ['b1', 2, 1]]);
});

test('push keys convert from URL-safe base64 and credits are totalled', () => {
  assert.deepEqual([...urlBase64ToUint8Array('AQID')], [1, 2, 3]);
  assert.deepEqual([...urlBase64ToUint8Array('-_8')], [251, 255]);
  assert.equal(totalCreditsRemaining([{ sessions_remaining: 3 }, { sessions_remaining: '4' }]), 7);
  const now = Date.parse('2026-06-01T12:00:00Z');
  assert.equal(isUpcoming({ status: 'scheduled', ends_at: '2026-06-01T13:00:00Z' }, now), true);
  assert.equal(isUpcoming({ status: 'canceled', ends_at: '2026-06-01T13:00:00Z' }, now), false);
  assert.equal(isUpcoming({ status: 'scheduled', ends_at: '2026-06-01T11:00:00Z' }, now), false);
  assert.equal(clientLabel({ client_name: '', client_email: 'a@b.c' }), 'a@b.c');
});