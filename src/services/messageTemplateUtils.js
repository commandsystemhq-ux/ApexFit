// Pure helpers for the coach's ready-made chat messages: categories, validation, the {client_name} placeholder and the
// starter set. Nothing here touches the network.
import { fillTemplate } from './textTemplate.js';

export const TEMPLATE_CATEGORIES = ['welcome', 'encouragement', 'checkin', 'diet', 'custom'];
export const TEMPLATE_CATEGORY_KEYS = {
  welcome: 'tplCatWelcome',
  encouragement: 'tplCatEncouragement',
  checkin: 'tplCatCheckin',
  diet: 'tplCatDiet',
  custom: 'tplCatCustom',
};
export const TEMPLATE_TITLE_MAX = 60;
export const TEMPLATE_BODY_MAX = 2000;
export const TEMPLATE_LIMIT = 50;
export const CLIENT_NAME_PLACEHOLDER = '{client_name}';

// The four starter messages. Their texts are translated: tplStarter_<id>_title and tplStarter_<id>_body.
export const STARTER_TEMPLATES = [
  { id: 'welcome', category: 'welcome' },
  { id: 'encouragement', category: 'encouragement' },
  { id: 'checkin', category: 'checkin' },
  { id: 'diet', category: 'diet' },
];

export function emptyTemplateForm() {
  return { id: null, title: '', category: 'custom', body: '' };
}

// Errors are translation keys.
export function validateTemplate({ title, category, body }) {
  const errors = {};
  const name = String(title ?? '').trim();
  const text = String(body ?? '').trim();
  if (name.length < 1 || name.length > TEMPLATE_TITLE_MAX) errors.title = 'tplErrTitle';
  if (text.length < 1 || text.length > TEMPLATE_BODY_MAX) errors.body = 'tplErrBody';
  if (!TEMPLATE_CATEGORIES.includes(category)) errors.category = 'tplErrCategory';
  return { valid: Object.keys(errors).length === 0, errors, payload: { title: name, category, body: text } };
}

// How a client is greeted: their name, or the part of an e-mail address before the @ when no name is known.
export function friendlyClientName(name) {
  const text = String(name ?? '').trim();
  if (!text) return '';
  return text.includes('@') ? text.split('@')[0] : text;
}

export function applyTemplate(template, clientName) {
  return fillTemplate(template?.body ?? template ?? '', { client_name: friendlyClientName(clientName) });
}

// Puts a template at the end of what the coach already typed, on a new line, and never beyond the message limit.
export function insertIntoDraft(draft, text, max = TEMPLATE_BODY_MAX) {
  const current = String(draft ?? '');
  const joined = current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text;
  return joined.slice(0, max);
}

// The starter templates the coach does not have yet (compared by name, ignoring case), ready to be saved.
export function starterPayloads(t, existingTitles = []) {
  const taken = new Set(existingTitles.map((title) => String(title).trim().toLowerCase()));
  return STARTER_TEMPLATES
    .map((starter) => ({ title: t(`tplStarter_${starter.id}_title`), category: starter.category, body: t(`tplStarter_${starter.id}_body`) }))
    .filter((payload) => !taken.has(payload.title.trim().toLowerCase()));
}

export function groupTemplates(templates) {
  const groups = TEMPLATE_CATEGORIES.map((category) => ({ category, items: templates.filter((item) => item.category === category) }));
  return groups.filter((group) => group.items.length > 0);
}
