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

  return {
    slug,
    name: cleanString(record.name, 'name', 160),
    category,
    primary_muscles: primaryMuscles,
    equipment,
    difficulty,
    instructions: cleanStringList(record.instructions ?? [], 'instructions', 100, 2000),
    demo_video_url: cleanOptionalHttpsUrl(record.demo_video_url, 'demo_video_url'),
    thumbnail_url: cleanOptionalHttpsUrl(record.thumbnail_url, 'thumbnail_url'),
  };
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
