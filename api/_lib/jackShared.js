export class ToolError extends Error {}

export function requireText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ToolError(`${label} is required.`);
  if (text.length > max) throw new ToolError(`${label} is too long (max ${max} characters).`);
  return text;
}

// Finds exactly one item for a spoken name. Several matches are returned to the model as a question to ask.
export function matchOne(items, query, keysOf, label) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) throw new ToolError(`${label} is required.`);
  const keys = (item) => keysOf(item).filter(Boolean).map((key) => String(key).toLowerCase());
  const describe = (list) => list.slice(0, 6).map((item) => keysOf(item).find(Boolean)).join(', ');

  const exact = items.filter((item) => keys(item).includes(needle));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new ToolError(`Several ${label}s match "${query}": ${describe(exact)}. Ask which one.`);

  const partial = items.filter((item) => keys(item).some((key) => key.includes(needle)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new ToolError(`Several ${label}s match "${query}": ${describe(partial)}. Ask which one.`);

  throw new ToolError(`No ${label} matches "${query}".${items.length ? ` Available: ${describe(items)}.` : ''}`);
}

// YYYY-MM-DD (UTC) from a timestamp string or Date.
export function isoDay(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? '' : new Date(time).toISOString().slice(0, 10);
}
