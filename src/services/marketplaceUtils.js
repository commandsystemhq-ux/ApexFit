// Pure helpers for the coaches marketplace: the coach's public profile form, search filters, reviews, reports and
// contact requests. The database enforces every rule again; these checks only give people an answer before a round trip.
// Error values are translation keys. Nothing here touches the network.
import { validateVideoLink } from './exerciseVideo.js';

export const TRAINING_MODES = ['online', 'in_person', 'both'];
export const TRAINING_MODE_KEYS = { online: 'mkModeOnline', in_person: 'mkModeInPerson', both: 'mkModeBoth' };
export const REPORT_REASONS = ['spam', 'misleading', 'inappropriate', 'harassment', 'fake', 'other'];
export const REPORT_REASON_KEYS = {
  spam: 'mkReasonSpam', misleading: 'mkReasonMisleading', inappropriate: 'mkReasonInappropriate', harassment: 'mkReasonHarassment', fake: 'mkReasonFake', other: 'mkReasonOther',
};
export const REQUEST_STATUS_KEYS = { pending: 'mkStatusPending', accepted: 'mkStatusAccepted', declined: 'mkStatusDeclined', cancelled: 'mkStatusCancelled' };
export const HIDDEN_REASON_KEYS = {
  not_listed: 'mkWhyNotListed', hidden_by_moderation: 'mkWhyModeration', subscription_inactive: 'mkWhySubscription', assistant_trainer: 'mkWhyTrainer',
};

export const HEADLINE_MAX = 120;
export const HEADLINE_MIN_TO_LIST = 10;
export const BIO_MAX = 2000;
export const BIO_MIN_TO_LIST = 30;
export const CITY_MAX = 80;
export const LIST_LIMITS = { specialties: { count: 10, length: 40 }, certifications: { count: 10, length: 80 }, languages: { count: 8, length: 2 } };
export const REQUEST_MESSAGE_MAX = 500;
export const REQUESTS_PER_DAY = 3;
export const REVIEW_COMMENT_MAX = 1000;
export const REPLY_MAX = 1000;
export const REPORT_DETAILS_MAX = 500;
export const MODERATION_REASON_MAX = 500;
export const REVIEW_WAIT_DAYS = 14;
export const SEARCH_PAGE_SIZE = 12;

// Languages a coach can offer. Their names come from the browser in the reader's language.
export const MARKETPLACE_LANGUAGES = ['en', 'ar', 'de', 'fr', 'es', 'it', 'pt', 'tr', 'ru', 'fa', 'ur', 'hi', 'zh'];

export const COUNTRY_CODES = (
  'AE SA EG JO LB KW QA BH OM IQ SY YE PS MA DZ TN LY SD SO DJ MR KM TR IR IL CY '
  + 'US CA MX BR AR CL CO PE VE EC UY PY BO CR PA DO CU GT HN SV NI PR JM TT '
  + 'GB IE FR DE ES PT IT NL BE LU CH AT SE NO DK FI IS PL CZ SK HU RO BG GR HR RS SI BA AL MK ME XK UA BY RU LT LV EE MT '
  + 'IN PK BD LK NP AF CN JP KR TH VN MY SG ID PH MM KH LA MN KZ UZ AZ GE AM '
  + 'AU NZ FJ ZA NG KE GH ET TZ UG SN CI CM AO MZ ZW ZM RW'
).split(' ');

function displayNames(locale, type) {
  try {
    return new Intl.DisplayNames([locale], { type, fallback: 'code' });
  } catch {
    return null;
  }
}

export function countryName(code, locale = 'en') {
  const value = String(code || '').toUpperCase();
  if (!value) return '';
  return displayNames(locale, 'region')?.of(value) || value;
}

export function languageName(code, locale = 'en') {
  const value = String(code || '').toLowerCase();
  if (!value) return '';
  return displayNames(locale, 'language')?.of(value) || value;
}

// Countries sorted by their name in the reader's language.
export function countryOptions(locale = 'en') {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
}

export function placeLabel(profile, locale = 'en') {
  return [String(profile?.city || '').trim(), countryName(profile?.country_code, locale)].filter(Boolean).join(', ');
}

// "Strength, Mobility" or a line break in, a clean list out: trimmed, no empty entries, no repeats (ignoring case).
export function parseList(text, { lower = false } = {}) {
  const seen = new Set();
  const items = [];
  for (const part of String(text ?? '').split(/[\n,;\u060C]+/)) {
    const value = part.replace(/\s+/g, ' ').trim();
    const item = lower ? value.toLowerCase() : value;
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    items.push(item);
  }
  return items;
}

export const listToText = (items) => (Array.isArray(items) ? items.join(', ') : '');

export function emptyProfileForm() {
  return {
    isListed: false, acceptingClients: true, headline: '', bio: '', specialties: '', certifications: '', languages: [], yearsExperience: '',
    city: '', countryCode: '', trainingMode: 'online', introVideoUrl: '',
  };
}

export function profileToForm(profile) {
  if (!profile) return emptyProfileForm();
  return {
    isListed: Boolean(profile.is_listed),
    acceptingClients: profile.accepting_clients !== false,
    headline: profile.headline || '',
    bio: profile.bio || '',
    specialties: listToText(profile.specialties),
    certifications: listToText(profile.certifications),
    languages: Array.isArray(profile.languages) ? profile.languages : [],
    yearsExperience: profile.years_experience === null || profile.years_experience === undefined ? '' : String(profile.years_experience),
    city: profile.city || '',
    countryCode: profile.country_code || '',
    trainingMode: TRAINING_MODES.includes(profile.training_mode) ? profile.training_mode : 'online',
    introVideoUrl: profile.intro_video_url || '',
  };
}

// The form as the RPC wants it, or the list of problems (each one a translation key under its field).
export function validateProfileForm(form) {
  const errors = {};
  const headline = String(form.headline ?? '').trim();
  const bio = String(form.bio ?? '').trim();
  const city = String(form.city ?? '').replace(/\s+/g, ' ').trim();
  const specialties = parseList(form.specialties);
  const certifications = parseList(form.certifications);
  const languages = [...new Set((form.languages || []).map((code) => String(code).toLowerCase()))];
  const countryCode = String(form.countryCode || '').toUpperCase();
  const yearsText = String(form.yearsExperience ?? '').trim();
  const video = validateVideoLink(form.introVideoUrl);

  if (headline.length > HEADLINE_MAX) errors.headline = 'mkErrHeadlineLong';
  if (bio.length > BIO_MAX) errors.bio = 'mkErrBioLong';
  if (city.length > CITY_MAX) errors.city = 'mkErrCityLong';
  if (specialties.length > LIST_LIMITS.specialties.count || specialties.some((item) => item.length > LIST_LIMITS.specialties.length)) errors.specialties = 'mkErrSpecialties';
  if (certifications.length > LIST_LIMITS.certifications.count || certifications.some((item) => item.length > LIST_LIMITS.certifications.length)) errors.certifications = 'mkErrCertifications';
  if (languages.length > LIST_LIMITS.languages.count) errors.languages = 'mkErrLanguages';
  if (countryCode && !COUNTRY_CODES.includes(countryCode)) errors.countryCode = 'mkErrCountry';
  if (!TRAINING_MODES.includes(form.trainingMode)) errors.trainingMode = 'mkErrMode';
  let years = null;
  if (yearsText) {
    years = Number(yearsText);
    if (!Number.isInteger(years) || years < 0 || years > 60) errors.yearsExperience = 'mkErrYears';
  }
  if (!video.ok) errors.introVideoUrl = video.error === 'evErr_unsupported' ? 'mkErrVideoUnsupported' : 'mkErrVideoInvalid';

  if (form.isListed) {
    if (headline.length < HEADLINE_MIN_TO_LIST) errors.headline = errors.headline || 'mkErrHeadlineShort';
    if (bio.length < BIO_MIN_TO_LIST) errors.bio = errors.bio || 'mkErrBioShort';
    if (specialties.length === 0) errors.specialties = errors.specialties || 'mkErrSpecialtiesNeeded';
    if (languages.length === 0) errors.languages = errors.languages || 'mkErrLanguagesNeeded';
    if (!countryCode) errors.countryCode = errors.countryCode || 'mkErrCountryNeeded';
  }

  const valid = Object.keys(errors).length === 0;
  return {
    valid,
    errors,
    payload: valid ? {
      isListed: Boolean(form.isListed), acceptingClients: Boolean(form.acceptingClients), headline, bio, specialties, languages, certifications,
      yearsExperience: years, city, countryCode: countryCode || null, trainingMode: form.trainingMode, introVideoUrl: video.value || null,
    } : null,
  };
}

// Which of the visibility rules keep a profile out of the search, as translation keys (empty when it is listed).
export function visibilityProblems(profile) {
  return (profile?.hidden_reasons || []).map((reason) => HIDDEN_REASON_KEYS[reason]).filter(Boolean);
}

export function emptyFilters() {
  return { query: '', specialty: '', language: '', country: '', city: '', mode: '', minRating: '', acceptingOnly: false };
}

export function hasActiveFilters(filters) {
  const empty = emptyFilters();
  return Object.keys(empty).some((key) => String(filters?.[key] ?? '') !== String(empty[key]));
}

// Search filters as the arguments of search_marketplace_coaches; empty filters are not sent.
export function searchArgs(filters, page = 0) {
  const text = (value) => String(value ?? '').trim();
  const rating = Number(filters.minRating);
  return {
    p_query: text(filters.query) || null,
    p_specialty: text(filters.specialty) || null,
    p_language: text(filters.language) || null,
    p_country: text(filters.country) || null,
    p_city: text(filters.city) || null,
    p_mode: ['online', 'in_person'].includes(filters.mode) ? filters.mode : null,
    p_min_rating: rating >= 1 && rating <= 5 ? rating : null,
    p_accepting_only: Boolean(filters.acceptingOnly),
    p_limit: SEARCH_PAGE_SIZE,
    p_offset: Math.max(0, Math.floor(page)) * SEARCH_PAGE_SIZE,
  };
}

export function pageCount(total) {
  return Math.max(1, Math.ceil((Number(total) || 0) / SEARCH_PAGE_SIZE));
}

// Specialties found on the coaches of the current result, so the filter offers real choices.
export function specialtyChoices(items) {
  const byKey = new Map();
  for (const item of items || []) for (const name of item.specialties || []) if (!byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export function formatRating(value) {
  const number = Number(value) || 0;
  return number > 0 ? number.toFixed(1) : '-';
}

// Whole and half stars for a rating from 0 to 5: ['full', 'full', 'half', 'empty', 'empty'].
export function starStates(value) {
  const rounded = Math.round((Math.max(0, Math.min(5, Number(value) || 0))) * 2) / 2;
  return Array.from({ length: 5 }, (_, index) => {
    if (rounded >= index + 1) return 'full';
    return rounded >= index + 0.5 ? 'half' : 'empty';
  });
}

// Share of each star in the reviews, as whole percentages for the bars.
export function distributionBars(distribution, count) {
  const total = Number(count) || 0;
  return [5, 4, 3, 2, 1].map((stars) => {
    const amount = Number(distribution?.[stars]) || 0;
    return { stars, amount, percent: total > 0 ? Math.round((amount / total) * 100) : 0 };
  });
}

export function validateReview({ rating, comment }) {
  const errors = {};
  const text = String(comment ?? '').trim();
  if (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) errors.rating = 'mkErrRating';
  if (text.length > REVIEW_COMMENT_MAX) errors.comment = 'mkErrCommentLong';
  return { valid: Object.keys(errors).length === 0, errors, rating: Number(rating), comment: text };
}

export function validateReply(text) {
  const value = String(text ?? '').trim();
  if (!value) return { valid: false, error: 'mkErrReplyEmpty', value };
  if (value.length > REPLY_MAX) return { valid: false, error: 'mkErrReplyLong', value };
  return { valid: true, error: null, value };
}

export function validateReport({ reason, details }) {
  const text = String(details ?? '').trim();
  if (!REPORT_REASONS.includes(reason)) return { valid: false, error: 'mkErrReason', reason, details: text };
  if (text.length > REPORT_DETAILS_MAX) return { valid: false, error: 'mkErrDetailsLong', reason, details: text };
  return { valid: true, error: null, reason, details: text };
}

export function validateRequestMessage(text) {
  const value = String(text ?? '').trim();
  if (!value) return { valid: false, error: 'mkErrMessageEmpty', value };
  if (value.length > REQUEST_MESSAGE_MAX) return { valid: false, error: 'mkErrMessageLong', value };
  return { valid: true, error: null, value };
}

export function validateModerationReason(text, { required = true } = {}) {
  const value = String(text ?? '').trim();
  if (required && value.length < 3) return { valid: false, error: 'mkErrReasonShort', value };
  if (value.length > MODERATION_REASON_MAX) return { valid: false, error: 'mkErrReasonLong', value };
  return { valid: true, error: null, value };
}

// Whole days left until a client may review (0 when they already can).
export function daysUntilReview(eligibleAt, now = new Date()) {
  const time = Date.parse(eligibleAt);
  if (Number.isNaN(time)) return 0;
  return Math.max(0, Math.ceil((time - now.getTime()) / 86_400_000));
}

// What the contact button and form should do for this coach, from the detail the database returned.
export function contactState(coach) {
  const viewer = coach?.viewer;
  if (!viewer?.is_client) return 'not_client';
  if (viewer.is_linked) return 'linked';
  if (viewer.pending_request) return 'pending';
  if (coach.accepting_clients === false) return 'closed';
  if ((viewer.requests_left ?? 0) <= 0) return 'limit';
  return 'can_request';
}

// The part of the page a request leads to once the coach accepted: the coach opens the chat with the client.
export function chatPathForCoach(clientId) {
  return `/messages?with=${encodeURIComponent(clientId)}`;
}

// Only https links to the intro video are ever embedded (see getVideoPlayback); this is a quick yes/no for the form.
export function isAllowedVideoLink(url) {
  const result = validateVideoLink(url);
  return result.ok && !result.empty;
}

// The /coaches/:id address of a coach; anything that is not a UUID gets the list instead.
export function coachPath(coachId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(coachId || '')) ? `/coaches/${coachId}` : '/coaches';
}
