const num = (value) => (value === null || value === undefined ? null : Number(value));
const trim = (value) => Number(value).toString();

// The numbers a suggestion shows, ready to put into a translated sentence. `kind` is 'weight' or 'reps'.
export function suggestionNumbers(suggestion) {
  if (suggestion.kind === 'weight') {
    const from = num(suggestion.current_weight_kg);
    const to = num(suggestion.suggested_weight_kg);
    return { kind: 'weight', from: trim(from), to: trim(to), step: trim(Math.round((to - from) * 100) / 100) };
  }
  const from = num(suggestion.current_reps);
  const to = num(suggestion.suggested_reps);
  return { kind: 'reps', from: trim(from), to: trim(to), step: trim(to - from) };
}

export const suggestionTextKey = (suggestion) => (suggestion.kind === 'weight' ? 'pgWeightText' : 'pgRepsText');

// "12 Nov, 9 Nov": the two sessions that earned the suggestion.
export function sessionDates(suggestion, locale = 'en') {
  const dates = Array.isArray(suggestion.reason?.sessions) ? suggestion.reason.sessions : [];
  return dates.map((date) => new Date(`${date}T12:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' })).join(', ');
}

// What the client sees for an exercise in their workout log.
export function targetFor(targets, exerciseId) {
  const row = (targets || []).find((item) => item.exercise_id === exerciseId);
  if (!row) return null;
  return { weight: num(row.target_weight_kg), reps: num(row.target_reps) };
}

export function targetText(target, t) {
  if (!target) return '';
  if (target.weight !== null) return t('pgTarget').replace('{weight}', trim(target.weight));
  return t('pgTargetReps').replace('{reps}', trim(target.reps));
}

// The weight a set starts with when the exercise has a target: the target, so the client sees what to lift.
export function startingWeight(target) {
  return target && target.weight !== null ? String(target.weight) : '';
}