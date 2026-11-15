export const WORKFLOW_TRIGGERS = ['client_joined', 'plan_assigned', 'workout_missed', 'milestone_reached'];
export const WORKFLOW_ACTIONS = ['send_message', 'assign_task'];
export const TEMPLATE_VARIABLES = ['client_name', 'coach_name', 'brand_name'];

export const MAX_WORKFLOW_STEPS = 10;
export const MAX_DELAY_DAYS = 365;
export const LIMITS = { name: 120, description: 500, message: 1500, task: 120 };

const VARIABLE_PATTERN = /\{\s*(client_name|coach_name|brand_name)\s*\}/gi;

// Mirrors public.workflow_render_template: unknown placeholders are left untouched.
export function renderWorkflowTemplate(template, values = {}) {
  return String(template ?? '').replace(VARIABLE_PATTERN, (_, name) => String(values[name.toLowerCase()] ?? ''));
}

export function insertVariable(text, variable, selectionStart = text.length, selectionEnd = selectionStart) {
  const token = `{${variable}}`;
  const value = `${text.slice(0, selectionStart)}${token}${text.slice(selectionEnd)}`;
  return { value, cursor: selectionStart + token.length };
}

export function emptyStep(overrides = {}) {
  return { delay_days: 0, action_type: 'send_message', message_template: '', task_title: '', ...overrides };
}

export function emptyWorkflow(overrides = {}) {
  return {
    id: null,
    name: '',
    description: '',
    trigger_type: 'client_joined',
    is_active: true,
    steps: [emptyStep()],
    ...overrides,
  };
}

// Ready-made sequences. Texts live in the translations so the sequence is created in the coach's language.
export const WORKFLOW_PRESETS = [
  {
    id: 'welcome',
    trigger_type: 'client_joined',
    nameKey: 'wfPresetWelcomeName',
    descriptionKey: 'wfPresetWelcomeDescription',
    steps: [
      { delay_days: 0, action_type: 'send_message', messageKey: 'wfPresetWelcomeMsg0' },
      { delay_days: 1, action_type: 'assign_task', taskKey: 'wfPresetWelcomeTask1', messageKey: 'wfPresetWelcomeMsg1' },
      { delay_days: 3, action_type: 'send_message', messageKey: 'wfPresetWelcomeMsg3' },
    ],
  },
  {
    id: 'consistency',
    trigger_type: 'workout_missed',
    nameKey: 'wfPresetConsistencyName',
    descriptionKey: 'wfPresetConsistencyDescription',
    steps: [
      { delay_days: 0, action_type: 'send_message', messageKey: 'wfPresetConsistencyMsg0' },
      { delay_days: 2, action_type: 'send_message', messageKey: 'wfPresetConsistencyMsg2' },
      { delay_days: 5, action_type: 'assign_task', taskKey: 'wfPresetConsistencyTask5', messageKey: 'wfPresetConsistencyMsg5' },
    ],
  },
  {
    id: 'measurements',
    trigger_type: 'plan_assigned',
    nameKey: 'wfPresetMeasurementsName',
    descriptionKey: 'wfPresetMeasurementsDescription',
    steps: [
      { delay_days: 0, action_type: 'send_message', messageKey: 'wfPresetMeasurementsMsg0' },
      { delay_days: 7, action_type: 'assign_task', taskKey: 'wfPresetMeasurementsTask7', messageKey: 'wfPresetMeasurementsMsg7' },
      { delay_days: 28, action_type: 'assign_task', taskKey: 'wfPresetMeasurementsTask28', messageKey: 'wfPresetMeasurementsMsg28' },
    ],
  },
];

export function buildPresetDraft(preset, translate) {
  return emptyWorkflow({
    name: translate(preset.nameKey),
    description: translate(preset.descriptionKey),
    trigger_type: preset.trigger_type,
    steps: preset.steps.map((step) => emptyStep({
      delay_days: step.delay_days,
      action_type: step.action_type,
      message_template: step.messageKey ? translate(step.messageKey) : '',
      task_title: step.taskKey ? translate(step.taskKey) : '',
    })),
  });
}

export function draftFromWorkflow(workflow) {
  return emptyWorkflow({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || '',
    trigger_type: workflow.trigger_type,
    is_active: workflow.is_active,
    steps: [...(workflow.steps || [])]
      .sort((left, right) => left.step_order - right.step_order)
      .map((step) => emptyStep({
        delay_days: step.delay_days,
        action_type: step.action_type,
        message_template: step.message_template || '',
        task_title: step.task_title || '',
      })),
  });
}

// Validates a draft and returns the exact payload the save_workflow function expects.
// Error values are translation keys so the form can show them in the active language.
export function validateWorkflowDraft(draft) {
  const errors = { steps: [] };
  const name = String(draft.name ?? '').trim();
  const description = String(draft.description ?? '').trim();

  if (!name) errors.name = 'wfErrName';
  else if (name.length > LIMITS.name) errors.name = 'wfErrNameLength';
  if (description.length > LIMITS.description) errors.description = 'wfErrDescriptionLength';
  if (!WORKFLOW_TRIGGERS.includes(draft.trigger_type)) errors.trigger = 'wfErrTrigger';

  const sourceSteps = Array.isArray(draft.steps) ? draft.steps : [];
  if (sourceSteps.length === 0 || sourceSteps.length > MAX_WORKFLOW_STEPS) errors.stepCount = 'wfErrStepCount';

  const steps = sourceSteps.map((step, index) => {
    const stepErrors = {};
    const delay = Number(step.delay_days);
    const message = String(step.message_template ?? '').trim();
    const task = String(step.task_title ?? '').trim();

    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_DAYS) stepErrors.delay = 'wfErrDelay';
    if (!WORKFLOW_ACTIONS.includes(step.action_type)) stepErrors.action = 'wfErrAction';
    if (step.action_type === 'send_message' && !message) stepErrors.message = 'wfErrMessage';
    if (step.action_type === 'assign_task' && !task) stepErrors.task = 'wfErrTask';
    if (message.length > LIMITS.message) stepErrors.message = 'wfErrMessageLength';
    if (task.length > LIMITS.task) stepErrors.task = 'wfErrTaskLength';

    errors.steps[index] = stepErrors;
    return {
      delay_days: delay,
      action_type: step.action_type,
      message_template: message,
      task_title: step.action_type === 'assign_task' ? task : '',
    };
  });

  const valid = !errors.name && !errors.description && !errors.trigger && !errors.stepCount
    && errors.steps.every((stepErrors) => Object.keys(stepErrors).length === 0);

  return {
    valid,
    errors,
    payload: {
      id: draft.id ?? null,
      name,
      description,
      trigger_type: draft.trigger_type,
      is_active: draft.is_active !== false,
      steps,
    },
  };
}

// What the client will receive and when, using sample names. Matches the text the engine inserts.
export function buildPreviewTimeline(steps, values, taskLabel = 'Task') {
  return steps.map((step, index) => {
    const message = renderWorkflowTemplate(step.message_template, values).trim();
    const title = renderWorkflowTemplate(step.task_title, values).trim();
    const text = step.action_type === 'assign_task'
      ? [`${taskLabel}: ${title}`, message].filter(Boolean).join('\n\n')
      : message;
    return { index, day: Number(step.delay_days) || 0, action: step.action_type, text };
  });
}

export function summarizeWorkflowLogs(logs) {
  const summary = new Map();
  for (const log of logs || []) {
    const entry = summary.get(log.workflow_id) || { sent: 0, pending: 0, skipped: 0, failed: 0 };
    if (log.status in entry) entry[log.status] += 1;
    summary.set(log.workflow_id, entry);
  }
  return summary;
}
