const categories = new Set(['strength', 'cardio', 'mobility', 'plyometrics', 'warmup']);
const difficulties = new Set(['beginner', 'intermediate', 'advanced']);
const equipmentOptions = new Set([
  'barbell', 'dumbbell', 'kettlebell', 'cable', 'machine', 'resistance_band', 'bodyweight', 'medicine_ball',
  'bench', 'smith_machine', 'trap_bar', 'landmine', 'plyometric_box', 'suspension_trainer', 'foam_roller', 'exercise_ball', 'other',
]);
const muscleOptions = new Set([
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quadriceps', 'hamstrings', 'glutes', 'calves',
  'core', 'lower_back', 'traps', 'neck', 'hip_flexors', 'adductors', 'abductors', 'full_body',
]);

function cleanString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new RangeError(`${field} must contain between 1 and ${maxLength} characters.`);
  }
  return cleaned;
}

function cleanStringList(value, field, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${field} must be an array with no more than ${maxItems} items.`);
  }
  return [...new Set(value.map((item) => cleanString(item, field, maxLength)))];
}

const ANIMATION_PATH = /\.(gif|mp4|webm|webp)$/i;

function cleanAnimationUrl(value) {
  const href = cleanOptionalHttpsUrl(value, 'animation_url');
  if (href && !ANIMATION_PATH.test(new URL(href).pathname)) throw new TypeError('animation_url must point to a .gif, .webp, .mp4 or .webm file.');
  return href;
}

function cleanFrames(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) throw new TypeError('image_frames must be an array of at most 4 HTTPS URLs.');
  return [...new Set(value.map((frame) => cleanOptionalHttpsUrl(frame, 'image_frames')).filter(Boolean))];
}

function cleanOptionalHttpsUrl(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be an HTTPS URL or null.`);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError(`${field} must use HTTPS without embedded credentials.`);
  }
  return url.href;
}

const TRANSLATION_LOCALES = ['ar', 'de', 'fr', 'es'];

function cleanNameTranslations(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('name_i18n must be an object.');
  const result = {};
  for (const locale of TRANSLATION_LOCALES) {
    if (value[locale] !== undefined && value[locale] !== null && value[locale] !== '') result[locale] = cleanString(value[locale], `name_i18n.${locale}`, 160);
  }
  return result;
}

function cleanInstructionTranslations(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('instructions_i18n must be an object.');
  const result = {};
  for (const locale of TRANSLATION_LOCALES) {
    if (value[locale] !== undefined && value[locale] !== null) result[locale] = cleanStringList(value[locale], `instructions_i18n.${locale}`, 100, 2000);
  }
  return result;
}

// Adds the translated names and steps found in the translation files ({ names: { ar: { slug: name } }, instructions: { ar: { slug: [steps] } } })
// to each catalog record. Every record gets both objects (empty when it has no translation) so a batch has uniform columns.
export function mergeExerciseTranslations(records, { names = {}, instructions = {} } = {}) {
  const any = TRANSLATION_LOCALES.some((locale) => names[locale] || instructions[locale]);
  if (!any) return records;
  return records.map((record) => {
    const name_i18n = {};
    const instructions_i18n = {};
    for (const locale of TRANSLATION_LOCALES) {
      const name = names[locale]?.[record.slug];
      if (typeof name === 'string' && name.trim()) name_i18n[locale] = name.trim();
      const steps = instructions[locale]?.[record.slug];
      if (Array.isArray(steps) && steps.length > 0) instructions_i18n[locale] = steps;
    }
    return { ...record, name_i18n, instructions_i18n };
  });
}

export function normalizeExerciseRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Each exercise record must be an object.');
  }

  const slug = cleanString(record.slug, 'slug', 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new TypeError('slug must contain lowercase letters, numbers, and single hyphens.');
  }

  const category = cleanString(record.category, 'category', 40);
  if (!categories.has(category)) throw new TypeError(`Unsupported exercise category: ${category}.`);

  const difficulty = cleanString(record.difficulty, 'difficulty', 20);
  if (!difficulties.has(difficulty)) throw new TypeError(`Unsupported exercise difficulty: ${difficulty}.`);

  const primaryMuscles = cleanStringList(record.primary_muscles ?? [], 'primary_muscles', 20, 60);
  if (primaryMuscles.some((muscle) => !muscleOptions.has(muscle))) {
    throw new TypeError('primary_muscles contains a value not supported by the exercise filters.');
  }
  const equipment = cleanStringList(record.equipment ?? [], 'equipment', 20, 60);
  if (equipment.some((item) => !equipmentOptions.has(item))) {
    throw new TypeError('equipment contains a value not supported by the exercise filters.');
  }

  const nameTranslations = cleanNameTranslations(record.name_i18n);
  const instructionTranslations = cleanInstructionTranslations(record.instructions_i18n);

  return {
    ...(nameTranslations ? { name_i18n: nameTranslations } : {}),
    ...(instructionTranslations ? { instructions_i18n: instructionTranslations } : {}),
    slug,
    name: cleanString(record.name, 'name', 160),
    category,
    primary_muscles: primaryMuscles,
    equipment,
    difficulty,
    instructions: cleanStringList(record.instructions ?? [], 'instructions', 100, 2000),
    demo_video_url: cleanOptionalHttpsUrl(record.demo_video_url, 'demo_video_url'),
    thumbnail_url: cleanOptionalHttpsUrl(record.thumbnail_url, 'thumbnail_url'),
    animation_url: cleanAnimationUrl(record.animation_url),
    image_frames: cleanFrames(record.image_frames),
  };
}

// Adds animations from a media file ({ slug: { animation_url, image_frames? } }) to catalog records. Unknown slugs are reported.
export function mergeExerciseMedia(records, media = {}) {
  const known = new Set(records.map((record) => record.slug));
  const unknown = Object.keys(media).filter((slug) => !known.has(slug));
  if (unknown.length) throw new Error(`Media file lists exercises that are not in the catalog: ${unknown.slice(0, 5).join(', ')}.`);
  return records.map((record) => (media[record.slug] ? { ...record, ...media[record.slug] } : record));
}

export function getExerciseVideoSource(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const hostname = url.hostname.toLowerCase();
  const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  if (hostname === 'youtu.be') {
    const videoId = url.pathname.split('/').filter(Boolean)[0];
    return videoId && /^[\w-]{11}$/.test(videoId)
      ? { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${videoId}` }
      : null;
  }
  if (youtubeHosts.has(hostname)) {
    const pathParts = url.pathname.split('/').filter(Boolean);
    const videoId = url.searchParams.get('v')
      || (['embed', 'shorts'].includes(pathParts[0]) ? pathParts[1] : null);
    return videoId && /^[\w-]{11}$/.test(videoId)
      ? { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${videoId}` }
      : null;
  }
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(hostname)) {
    const videoId = url.pathname.split('/').filter(Boolean).find((part) => /^\d+$/.test(part));
    return videoId ? { kind: 'iframe', src: `https://player.vimeo.com/video/${videoId}` } : null;
  }
  if (/\.(mp4|webm)$/i.test(url.pathname)) {
    return { kind: 'video', src: url.href };
  }
  return null;
}
