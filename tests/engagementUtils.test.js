import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { PAGES, navigationFor, pageForPath } from '../src/routes.js';
import {
  PARQ_KEYS,
  answersFromRecord,
  emptyAnswers,
  flaggedQuestions,
  needsMedicalClearance,
  onboardingNotices,
  validateAssessmentForm,
} from '../src/services/assessmentUtils.js';
import {
  CONTRACT_PRESETS,
  contractStatuses,
  countSignatures,
  isValidSignatureDataUrl,
  validateContractForm,
  validateSignatureInput,
} from '../src/services/contractUtils.js';
import { availableClients, describeGroup, validateAnnouncement, validateGroupForm } from '../src/services/groupUtils.js';
import { quickPromptKeys } from '../src/services/jackUtils.js';

const ALL_NO = Object.fromEntries(PARQ_KEYS.map((key) => [key, false]));

test('the PAR-Q has seven questions and any "yes" requires medical clearance', () => {
  assert.equal(PARQ_KEYS.length, 7);
  assert.equal(needsMedicalClearance(ALL_NO), false);
  assert.equal(needsMedicalClearance(emptyAnswers()), false);
  assert.equal(needsMedicalClearance(undefined), false);
  for (const key of PARQ_KEYS) {
    const answers = { ...ALL_NO, [key]: true };
    assert.equal(needsMedicalClearance(answers), true, key);
    assert.deepEqual(flaggedQuestions(answers), [key]);
  }
  assert.deepEqual(flaggedQuestions({ ...ALL_NO, q2: true, q6: true }), ['q2', 'q6']);
});

test('saved answers are restored safely', () => {
  assert.deepEqual(answersFromRecord({ q1: true, q2: false, q3: 'yes', extra: true }), { ...emptyAnswers(), q1: true, q2: false });
  assert.deepEqual(answersFromRecord(null), emptyAnswers());
});

test('the assessment form needs every answer and the goals, and reports the clearance outcome', () => {
  const ok = validateAssessmentForm({ answers: { ...ALL_NO, q4: true }, goals: '  Build muscle ', injuries: ' Sore shoulder ' });
  assert.equal(ok.valid, true);
  assert.equal(ok.clearance, true);
  assert.deepEqual(ok.payload, { answers: { ...ALL_NO, q4: true }, goals: 'Build muscle', injuries: 'Sore shoulder' });
  assert.equal(validateAssessmentForm({ answers: ALL_NO, goals: 'x', injuries: '' }).clearance, false);

  const missing = validateAssessmentForm({ answers: { ...emptyAnswers(), q1: true }, goals: ' ', injuries: 'i'.repeat(1001) });
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.errors, { answers: 'asmErrAnswers', goals: 'asmErrGoals', injuries: 'asmErrInjuriesLength' });
  assert.equal(validateAssessmentForm({ answers: ALL_NO, goals: 'g'.repeat(1001), injuries: '' }).errors.goals, 'asmErrGoalsLength');
});

test('clients are reminded of the assessment, required contracts and the clearance alert', () => {
  assert.deepEqual(onboardingNotices(null), []);
  assert.deepEqual(onboardingNotices({ has_coach: false, assessment_submitted: false, pending_contracts: 3 }), [], 'nothing to do without a coach');

  const fresh = onboardingNotices({ has_coach: true, assessment_submitted: false, medical_clearance_required: false, pending_contracts: 2 }, '/workouts');
  assert.deepEqual(fresh.map((notice) => [notice.id, notice.to, notice.count]), [['assessment', '/assessments', undefined], ['contracts', '/my-contracts', 2]]);

  const flagged = onboardingNotices({ has_coach: true, assessment_submitted: true, medical_clearance_required: true, pending_contracts: 0 }, '/workouts');
  assert.deepEqual(flagged.map((notice) => [notice.id, notice.kind]), [['clearance', 'warning']]);

  const onAssessmentPage = onboardingNotices({ has_coach: true, assessment_submitted: false, medical_clearance_required: false, pending_contracts: 1 }, '/assessments');
  assert.deepEqual(onAssessmentPage.map((notice) => notice.id), ['contracts'], 'no reminder on the page that fixes it');
  assert.deepEqual(onboardingNotices({ has_coach: true, assessment_submitted: true, medical_clearance_required: false, pending_contracts: 0 }), []);
});

test('signature images must be reasonable PNG data URLs', () => {
  const valid = `data:image/png;base64,${'A'.repeat(200)}`;
  assert.equal(isValidSignatureDataUrl(valid), true);
  for (const bad of ['', null, undefined, 'data:image/png;base64,AAAA', `data:image/jpeg;base64,${'A'.repeat(200)}`, `data:image/svg+xml;base64,${'A'.repeat(200)}`,
    `javascript:alert(1)//${'A'.repeat(200)}`, `${valid}"><img src=x>`, `data:image/png;base64,${'A'.repeat(300001)}`]) {
    assert.equal(isValidSignatureDataUrl(bad), false, String(bad).slice(0, 40));
  }
});

test('contract and signature forms validate with translatable errors', () => {
  const ok = validateContractForm({ title: ' Waiver ', content: ' Text ', required: 1 });
  assert.deepEqual(ok.payload, { title: 'Waiver', content: 'Text', required: true });
  assert.deepEqual(validateContractForm({ title: ' ', content: '' }).errors, { title: 'ctrErrTitle', content: 'ctrErrContent' });
  assert.equal(validateContractForm({ title: 't'.repeat(161), content: 'x' }).errors.title, 'ctrErrTitleLength');
  assert.equal(validateContractForm({ title: 't', content: 'c'.repeat(20001) }).errors.content, 'ctrErrContentLength');

  assert.deepEqual(validateSignatureInput({ name: ' Sara Ali ', hasInk: true, agreed: true }), { valid: true, errors: {}, name: 'Sara Ali' });
  assert.deepEqual(validateSignatureInput({ name: 'S', hasInk: false, agreed: false }).errors, { name: 'ctrErrName', signature: 'ctrErrSignature', agree: 'ctrErrAgree' });
  assert.equal(validateSignatureInput({ name: 'x'.repeat(121), hasInk: true, agreed: true }).valid, false);
});

test('contract status helpers match signatures to contracts and count only active clients', () => {
  const statuses = contractStatuses([{ id: 'a' }, { id: 'b' }], [{ contract_id: 'a', signed_at: '2026-01-02T00:00:00Z' }]);
  assert.deepEqual(statuses.map((item) => [item.id, item.signed, item.signed_at]), [['a', true, '2026-01-02T00:00:00Z'], ['b', false, null]]);
  assert.deepEqual(countSignatures({ signatures: [{ client_id: 'c1' }, { client_id: 'c2' }, { client_id: 'gone' }] }, ['c1', 'c2', 'c3']), { signed: 2, total: 3 });
  assert.deepEqual(countSignatures({}, []), { signed: 0, total: 0 });
});

test('group forms and member lists', () => {
  assert.deepEqual(validateGroupForm({ name: ' 90-day challenge ', description: ' Go! ' }).payload, { name: '90-day challenge', description: 'Go!' });
  assert.deepEqual(validateGroupForm({ name: ' ', description: 'd'.repeat(501) }).errors, { name: 'grpErrName', description: 'grpErrDescription' });
  assert.equal(validateGroupForm({ name: 'n'.repeat(81) }).errors.name, 'grpErrNameLength');
  assert.deepEqual(validateAnnouncement('  hi  '), { valid: true, error: '', body: 'hi' });
  assert.equal(validateAnnouncement('   ').error, 'grpErrAnnouncement');
  assert.equal(validateAnnouncement('x'.repeat(1001)).error, 'grpErrAnnouncementLength');

  const clients = [
    { client_id: 'a', status: 'active', client_name: 'A' },
    { client_id: 'b', status: 'active', client_name: 'B' },
    { client_id: 'c', status: 'archived', client_name: 'C' },
  ];
  assert.deepEqual(availableClients(clients, ['a']).map((client) => client.client_id), ['b'], 'members and archived clients are not offered');

  const group = describeGroup(
    {
      id: 'g', program_template_id: 'p1',
      members: [{ client_id: 'b', joined_at: '2026-02-01' }, { client_id: 'a', joined_at: '2026-01-01' }, { client_id: 'c', joined_at: '2026-03-01' }],
      announcements: [{ id: '1', created_at: '2026-01-01' }, { id: '2', created_at: '2026-02-01' }],
    },
    clients,
    [{ id: 'p1', title: 'Strength' }],
  );
  assert.deepEqual(group.members.map((member) => member.client_id), ['a', 'b', 'c']);
  assert.equal(group.program.title, 'Strength');
  assert.deepEqual(group.announcements.map((item) => item.id), ['2', '1']);
  assert.equal(group.activeMemberCount, 2);
  assert.equal(describeGroup({ id: 'g', program_template_id: 'gone' }, [], []).program, null);
});

test('new pages appear in the right role\'s sidebar and nowhere else', () => {
  const idsFor = (role) => navigationFor(role).flatMap((group) => group.items);
  for (const id of ['groups', 'contracts']) {
    assert.ok(idsFor('coach').includes(id), id);
    assert.ok(!idsFor('client').includes(id), id);
    assert.equal(PAGES[id].access, 'coach');
  }
  for (const id of ['assessments', 'myContracts', 'myGroups']) {
    assert.ok(idsFor('client').includes(id), id);
    assert.ok(!idsFor('coach').includes(id), id);
    assert.equal(PAGES[id].access, 'client');
  }
  assert.deepEqual(['/groups', '/contracts', '/assessments', '/my-contracts', '/my-groups'].map((path) => Boolean(pageForPath(path))), [true, true, true, true, true]);
});

test('every new screen is translated in all five languages', () => {
  const keys = new Set();
  for (const id of ['groups', 'contracts', 'assessments', 'myContracts', 'myGroups']) keys.add(PAGES[id].titleKey);
  for (const preset of CONTRACT_PRESETS) {
    keys.add(preset.titleKey);
    keys.add(preset.contentKey);
  }
  for (let question = 1; question <= 7; question += 1) keys.add(`asmQ${question}`);
  for (const key of Object.keys(translations.en)) if (/^(asm|ctr|grp|onb)/.test(key)) keys.add(key);
  assert.ok(keys.size > 150);

  for (const locale of supportedLocales) {
    for (const key of keys) assert.ok(translations[locale][key], `Missing ${key} for ${locale}`);
  }
  for (const locale of supportedLocales.filter((item) => item !== 'en')) {
    for (let question = 1; question <= 7; question += 1) {
      assert.notEqual(translations[locale][`asmQ${question}`], translations.en[`asmQ${question}`], `asmQ${question} is not translated for ${locale}`);
    }
    assert.notEqual(translations[locale].ctrPresetWaiverBody, translations.en.ctrPresetWaiverBody, locale);
  }
  assert.match(translations.ar.asmQ2, /صدرك/);
});

test('Jack suggests prompts for the new pages', () => {
  assert.ok(quickPromptKeys('coach', '/groups').includes('jackQ_coachGroup'));
  assert.ok(quickPromptKeys('coach', '/contracts').includes('jackQ_coachContract'));
  assert.ok(quickPromptKeys('client', '/assessments').includes('jackQ_clientAssessment'));
  assert.ok(quickPromptKeys('client', '/my-groups').includes('jackQ_clientGroups'));
});
