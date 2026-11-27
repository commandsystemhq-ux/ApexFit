import { normalizeSearchText } from './exerciseI18n.js';

// Client tags and types (pure helpers). A tag can be given to many clients and a client can have many tags;
// a type is a tag of kind "type" and a client has at most one.

export const TAG_COLORS = Object.freeze(['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink']);
export const TAG_KINDS = Object.freeze(['tag', 'type']);
export const MAX_TAG_NAME = 30;
export const MAX_TAGS_PER_CLIENT = 10;
export const MAX_TAGS_PER_COACH = 40;

// Offered with one click; the label comes from the translation `tgPreset_<key>` at the moment they are created.
export const SUGGESTED_TAGS = Object.freeze([
  { key: 'vip', kind: 'tag', color: 'amber' },
  { key: 'online', kind: 'type', color: 'blue' },
  { key: 'inPerson', kind: 'type', color: 'teal' },
  { key: 'cutting', kind: 'tag', color: 'red' },
  { key: 'bulking', kind: 'tag', color: 'green' },
  { key: 'special', kind: 'tag', color: 'purple' },
]);

export const emptyTagForm = () => ({ name: '', color: 'blue', kind: 'tag' });

export function validateTagForm(form) {
  const errors = {};
  const name = String(form.name ?? '').trim();
  if (name.length < 1 || name.length > MAX_TAG_NAME) errors.name = 'tgErr_name';
  if (!TAG_COLORS.includes(form.color)) errors.color = 'tgErr_color';
  if (!TAG_KINDS.includes(form.kind)) errors.kind = 'tgErr_kind';
  return { ok: Object.keys(errors).length === 0, errors, payload: { name, color: form.color, kind: form.kind } };
}

const byKindThenName = (left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'type' ? -1 : 1);

// Map of client id -> that client's tags (the type first, then the tags by name).
export function tagsByClient(assignments, tags) {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const result = new Map();
  for (const row of assignments) {
    const tag = byId.get(row.tag_id);
    if (!tag) continue;
    if (!result.has(row.client_id)) result.set(row.client_id, []);
    result.get(row.client_id).push(tag);
  }
  for (const list of result.values()) list.sort(byKindThenName);
  return result;
}

// The selection after a tag was switched: a type replaces the client's other type, a tag is added or removed.
export function toggleTag(selectedIds, tag, tags) {
  if (selectedIds.includes(tag.id)) return selectedIds.filter((id) => id !== tag.id);
  const typeIds = new Set(tags.filter((item) => item.kind === 'type').map((item) => item.id));
  const base = tag.kind === 'type' ? selectedIds.filter((id) => !typeIds.has(id)) : selectedIds;
  return [...base, tag.id];
}

export const selectionTooLarge = (selectedIds) => selectedIds.length > MAX_TAGS_PER_CLIENT;

// Clients that match the search words (in the name, e-mail or one of their tags), the chosen type and all chosen tags.
export function filterClients(clients, { query = '', typeId = '', tagIds = [] } = {}, tagMap = new Map()) {
  const words = normalizeSearchText(query).split(' ').filter(Boolean);
  return clients.filter((client) => {
    const own = tagMap.get(client.client_id) || [];
    if (typeId && !own.some((tag) => tag.id === typeId)) return false;
    if (tagIds.some((id) => !own.some((tag) => tag.id === id))) return false;
    if (words.length === 0) return true;
    const haystack = normalizeSearchText([client.client_name, client.client_email, ...own.map((tag) => tag.name)].filter(Boolean).join(' '));
    return words.every((word) => haystack.includes(word));
  });
}

// How many clients carry each tag: Map(tag id -> count).
export function countByTag(assignments) {
  const counts = new Map();
  for (const row of assignments) counts.set(row.tag_id, (counts.get(row.tag_id) || 0) + 1);
  return counts;
}

// Suggested tags the coach does not have yet (compared by name, ignoring case); `labelOf(key)` is the translated name.
export function missingSuggestions(tags, labelOf) {
  const have = new Set(tags.map((tag) => normalizeSearchText(tag.name)));
  return SUGGESTED_TAGS
    .map((suggestion) => ({ ...suggestion, name: labelOf(suggestion.key) }))
    .filter((suggestion) => !have.has(normalizeSearchText(suggestion.name)));
}
