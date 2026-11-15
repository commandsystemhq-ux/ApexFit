import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedCron } from '../api/_lib/cron.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { PAGES, navigationFor } from '../src/routes.js';
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_PRESETS,
  WORKFLOW_TRIGGERS,
  buildPresetDraft,
  buildPreviewTimeline,
  draftFromWorkflow,
  emptyStep,
  emptyWorkflow,
  insertVariable,
  renderWorkflowTemplate,
  summarizeWorkflowLogs,
  validateWorkflowDraft,
} from '../src/services/workflowUtils.js';

const values = { client_name: 'Sara', coach_name: 'Amal', brand_name: 'Amal Strength' };

test('templates replace every supported variable, ignoring case and inner spaces', () => {
  assert.equal(renderWorkflowTemplate('Hi {client_name}, I am {coach_name} from {brand_name}.', values), 'Hi Sara, I am Amal from Amal Strength.');
  assert.equal(renderWorkflowTemplate('{ CLIENT_NAME } and {client_name}', values), 'Sara and Sara');
  assert.equal(renderWorkflowTemplate('Hi {nickname}', values), 'Hi {nickname}');
  assert.equal(renderWorkflowTemplate(null, values), '');
  assert.equal(renderWorkflowTemplate('Hi {client_name}', { client_name: '$& \\1' }), 'Hi $& \\1');
});

test('variables are inserted at the cursor', () => {
  assert.deepEqual(insertVariable('Hi , welcome', 'client_name', 3), { value: 'Hi {client_name}, welcome', cursor: 16 });
  assert.deepEqual(insertVariable('Hi XX', 'coach_name', 3, 5), { value: 'Hi {coach_name}', cursor: 15 });
  assert.equal(insertVariable('Hi', 'brand_name').value, 'Hi{brand_name}');
});

test('a valid draft produces the payload for save_workflow', () => {
  const result = validateWorkflowDraft(emptyWorkflow({
    name: '  Onboarding ',
    trigger_type: 'plan_assigned',
    steps: [
      emptyStep({ delay_days: '0', message_template: ' Welcome {client_name} ' }),
      emptyStep({ delay_days: 7, action_type: 'assign_task', task_title: ' Upload measurements ', message_template: '' }),
    ],
  }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.payload, {
    id: null,
    name: 'Onboarding',
    description: '',
    trigger_type: 'plan_assigned',
    is_active: true,
    steps: [
      { delay_days: 0, action_type: 'send_message', message_template: 'Welcome {client_name}', task_title: '' },
      { delay_days: 7, action_type: 'assign_task', message_template: '', task_title: 'Upload measurements' },
    ],
  });
});

test('invalid drafts report translatable errors per field and per step', () => {
  const result = validateWorkflowDraft(emptyWorkflow({
    name: ' ',
    trigger_type: 'never',
    steps: [
      emptyStep({ delay_days: -1 }),
      emptyStep({ delay_days: 1.5, message_template: 'ok' }),
      emptyStep({ delay_days: 400, action_type: 'assign_task', task_title: '' }),
      emptyStep({ action_type: 'teleport' }),
    ],
  }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.name, 'wfErrName');
  assert.equal(result.errors.trigger, 'wfErrTrigger');
  assert.deepEqual(result.errors.steps[0], { delay: 'wfErrDelay', message: 'wfErrMessage' });
  assert.deepEqual(result.errors.steps[1], { delay: 'wfErrDelay' });
  assert.deepEqual(result.errors.steps[2], { delay: 'wfErrDelay', task: 'wfErrTask' });
  assert.equal(result.errors.steps[3].action, 'wfErrAction');

  assert.equal(validateWorkflowDraft(emptyWorkflow({ name: 'x', steps: [] })).errors.stepCount, 'wfErrStepCount');
  const tooMany = Array.from({ length: 11 }, () => emptyStep({ message_template: 'x' }));
  assert.equal(validateWorkflowDraft(emptyWorkflow({ name: 'x', steps: tooMany })).errors.stepCount, 'wfErrStepCount');
  assert.equal(validateWorkflowDraft(emptyWorkflow({ name: 'n'.repeat(121), steps: [emptyStep({ message_template: 'x' })] })).errors.name, 'wfErrNameLength');
  assert.equal(validateWorkflowDraft(emptyWorkflow({ name: 'x', steps: [emptyStep({ message_template: 'm'.repeat(1501) })] })).errors.steps[0].message, 'wfErrMessageLength');
});

test('a saved workflow round-trips back into an editable draft in step order', () => {
  const draft = draftFromWorkflow({
    id: 'w1', name: 'Plan', description: null, trigger_type: 'workout_missed', is_active: false,
    steps: [
      { step_order: 2, delay_days: 3, action_type: 'assign_task', message_template: null, task_title: 'Reply' },
      { step_order: 1, delay_days: 0, action_type: 'send_message', message_template: 'Hi', task_title: '' },
    ],
  });
  assert.equal(draft.id, 'w1');
  assert.equal(draft.is_active, false);
  assert.deepEqual(draft.steps.map((step) => step.delay_days), [0, 3]);
  assert.equal(validateWorkflowDraft(draft).valid, true);
});

test('there are three ready templates that build valid drafts in every language', () => {
  assert.equal(WORKFLOW_PRESETS.length, 3);
  for (const locale of supportedLocales) {
    const translate = (key) => {
      assert.ok(translations[locale][key], `Missing ${key} for ${locale}`);
      return translations[locale][key];
    };
    for (const preset of WORKFLOW_PRESETS) {
      const draft = buildPresetDraft(preset, translate);
      const result = validateWorkflowDraft(draft);
      assert.equal(result.valid, true, `${preset.id} (${locale}) should be valid`);
      assert.ok(WORKFLOW_TRIGGERS.includes(draft.trigger_type));
    }
  }
});

test('preview mirrors what the engine sends, including task prefixes', () => {
  const timeline = buildPreviewTimeline([
    emptyStep({ message_template: 'Hi {client_name}' }),
    emptyStep({ delay_days: 7, action_type: 'assign_task', task_title: 'Measure {client_name}', message_template: 'Use a tape.' }),
    emptyStep({ delay_days: '9', action_type: 'assign_task', task_title: 'Only title' }),
  ], values, 'Task');
  assert.deepEqual(timeline.map((item) => [item.day, item.text]), [
    [0, 'Hi Sara'],
    [7, 'Task: Measure Sara\n\nUse a tape.'],
    [9, 'Task: Only title'],
  ]);
});

test('log summaries count each status per workflow', () => {
  const summary = summarizeWorkflowLogs([
    { workflow_id: 'a', status: 'sent' }, { workflow_id: 'a', status: 'sent' }, { workflow_id: 'a', status: 'pending' },
    { workflow_id: 'b', status: 'failed' }, { workflow_id: 'b', status: 'unknown' },
  ]);
  assert.deepEqual(summary.get('a'), { sent: 2, pending: 1, skipped: 0, failed: 0 });
  assert.deepEqual(summary.get('b'), { sent: 0, pending: 0, skipped: 0, failed: 1 });
  assert.equal(summary.get('c'), undefined);
});

test('every locale translates all workflow builder strings and the page is a coach-only route', () => {
  const keys = [
    ...WORKFLOW_TRIGGERS.flatMap((trigger) => [`wfTrigger_${trigger}`, `wfTriggerHelp_${trigger}`]),
    ...WORKFLOW_ACTIONS.map((action) => `wfAction_${action}`),
    'workflows', 'workflowsTitle', 'wfSave', 'wfPreview',
  ];
  for (const locale of supportedLocales) {
    for (const key of keys) assert.ok(translations[locale][key], `Missing ${key} for ${locale}`);
  }
  assert.equal(PAGES.workflows.path, '/workflows');
  assert.equal(PAGES.workflows.access, 'coach');
  assert.ok(navigationFor('coach').some((group) => group.items.includes('workflows')));
  assert.ok(!navigationFor('client').some((group) => group.items.includes('workflows')));
});

test('the workflow cron endpoint only accepts the configured secret', () => {
  assert.equal(isAuthorizedCron('Bearer s3cret', 's3cret'), true);
  assert.equal(isAuthorizedCron('Bearer wrong!', 's3cret'), false);
  assert.equal(isAuthorizedCron('Bearer s3cret', ''), false);
  assert.equal(isAuthorizedCron('s3cret', 's3cret'), false);
  assert.equal(isAuthorizedCron(undefined, 's3cret'), false);
});
