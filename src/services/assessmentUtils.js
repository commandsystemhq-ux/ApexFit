import { PAGES } from '../routes.js';

export const PARQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
export const ASSESSMENT_LIMITS = { goals: 1000, injuries: 1000 };

// Short English topics for each standard PAR-Q question (used by Jack; the app shows the full translated text).
export const PARQ_TOPICS = {
  q1: 'doctor-diagnosed heart condition',
  q2: 'chest pain during physical activity',
  q3: 'chest pain at rest in the past month',
  q4: 'dizziness or loss of consciousness',
  q5: 'bone or joint problem that exercise could worsen',
  q6: 'medication for blood pressure or heart condition',
  q7: 'another reason not to exercise',
};

export function emptyAnswers() {
  return Object.fromEntries(PARQ_KEYS.map((key) => [key, null]));
}

export function answersFromRecord(record) {
  const answers = emptyAnswers();
  for (const key of PARQ_KEYS) {
    if (typeof record?.[key] === 'boolean') answers[key] = record[key];
  }
  return answers;
}

// Any "yes" means the client should get a doctor's clearance before training.
export function needsMedicalClearance(answers) {
  return PARQ_KEYS.some((key) => answers?.[key] === true);
}

export function flaggedQuestions(answers) {
  return PARQ_KEYS.filter((key) => answers?.[key] === true);
}

// Errors are translation keys so the form can show them in the active language.
export function validateAssessmentForm({ answers, goals, injuries }) {
  const errors = {};
  const cleanGoals = String(goals ?? '').trim();
  const cleanInjuries = String(injuries ?? '').trim();

  if (!PARQ_KEYS.every((key) => typeof answers?.[key] === 'boolean')) errors.answers = 'asmErrAnswers';
  if (!cleanGoals) errors.goals = 'asmErrGoals';
  else if (cleanGoals.length > ASSESSMENT_LIMITS.goals) errors.goals = 'asmErrGoalsLength';
  if (cleanInjuries.length > ASSESSMENT_LIMITS.injuries) errors.injuries = 'asmErrInjuriesLength';

  const valid = Object.keys(errors).length === 0;
  return {
    valid,
    errors,
    clearance: valid && needsMedicalClearance(answers),
    payload: {
      answers: Object.fromEntries(PARQ_KEYS.map((key) => [key, answers?.[key] === true])),
      goals: cleanGoals,
      injuries: cleanInjuries,
    },
  };
}

// The to-do notices shown to a client until onboarding is complete.
export function onboardingNotices(status, pathname = '') {
  if (!status?.has_coach) return [];
  const notices = [];
  if (status.medical_clearance_required) {
    notices.push({ id: 'clearance', kind: 'warning', textKey: 'onbClearance', to: PAGES.assessments.path });
  }
  if (!status.assessment_submitted && pathname !== PAGES.assessments.path) {
    notices.push({ id: 'assessment', kind: 'info', textKey: 'onbAssessment', to: PAGES.assessments.path });
  }
  if (status.pending_contracts > 0 && pathname !== PAGES.myContracts.path) {
    notices.push({ id: 'contracts', kind: 'info', textKey: 'onbContracts', count: status.pending_contracts, to: PAGES.myContracts.path });
  }
  return notices;
}
