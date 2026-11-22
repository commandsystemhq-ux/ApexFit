// Small pure helpers shared by the screens (no native modules, so they can be tested with plain Node).

export function parseWeight(value) {
  const weight = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(weight) && weight >= 20 && weight <= 400 ? Math.round(weight * 10) / 10 : null;
}

export function localDateString(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// The name of an exercise in the person's language, falling back to the English name.
export function exerciseName(exercise, locale) {
  return exercise?.name_i18n?.[locale] || exercise?.name || '';
}

// Adds or replaces one chat message, keeping the list oldest first and showing a message once. A message the person
// just sent (matched by client_ref) is replaced by the saved one.
export function upsertMessage(list, incoming) {
  const rest = list.filter((message) => message.id !== incoming.id && !(incoming.client_ref && message.client_ref === incoming.client_ref));
  return [...rest, incoming].sort((a, b) => (Date.parse(a.created_at) - Date.parse(b.created_at)) || String(a.id).localeCompare(String(b.id)));
}