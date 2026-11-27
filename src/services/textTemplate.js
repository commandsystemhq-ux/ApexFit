// Replaces {placeholders} in a text with values. A placeholder without a value is left as it is, so a typo stays
// visible instead of silently disappearing.
export function fillTemplate(text, values = {}) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined && values[key] !== null ? String(values[key]) : match
  ));
}
