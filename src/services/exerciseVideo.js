import { getExerciseVideoSource } from './exerciseCatalogUtils.js';

export const MAX_VIDEO_LINK = 500;
const PROVIDER_LABELS = { youtube: 'YouTube', vimeo: 'Vimeo', file: 'MP4 / WebM' };

// What to play for a video link: an embedded player from YouTube (privacy-enhanced youtube-nocookie.com) or Vimeo
// (do-not-track), or a plain video file. `autoplay` is for the moment the person presses play. null when the link is
// not one of those: nothing is ever embedded from another site.
export function getVideoPlayback(rawUrl, { autoplay = false } = {}) {
  const source = getExerciseVideoSource(rawUrl);
  if (!source) return null;
  if (source.kind === 'video') return { kind: 'video', provider: 'file', src: source.src, watchUrl: source.src };
  const url = new URL(source.src);
  if (url.hostname === 'www.youtube-nocookie.com') {
    url.search = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', ...(autoplay ? { autoplay: '1' } : {}) }).toString();
    const id = url.pathname.split('/').pop();
    return { kind: 'iframe', provider: 'youtube', src: url.href, watchUrl: `https://www.youtube.com/watch?v=${id}` };
  }
  url.search = new URLSearchParams({ dnt: '1', ...(autoplay ? { autoplay: '1' } : {}) }).toString();
  const id = url.pathname.split('/').pop();
  return { kind: 'iframe', provider: 'vimeo', src: url.href, watchUrl: `https://vimeo.com/${id}` };
}

export const providerLabel = (provider) => PROVIDER_LABELS[provider] || '';

// Checks what the coach typed. `error` is a translation key.
export function validateVideoLink(text) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: true, empty: true, value: '', provider: null, error: null };
  if (value.length > MAX_VIDEO_LINK) return { ok: false, empty: false, value, provider: null, error: 'evErr_invalid' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, empty: false, value, provider: null, error: 'evErr_invalid' };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /\s/.test(value)) return { ok: false, empty: false, value, provider: null, error: 'evErr_invalid' };
  const playback = getVideoPlayback(value);
  if (!playback) return { ok: false, empty: false, value, provider: null, error: 'evErr_unsupported' };
  return { ok: true, empty: false, value, provider: playback.provider, error: null };
}

// Puts each coach's own video in place of the library's: `overrides` is [{ exercise_id, video_url }]. The exercise says
// where its video came from, so the screen can tell the coach it is theirs.
export function mergeVideoOverrides(exercises, overrides) {
  const byExercise = new Map();
  for (const row of overrides || []) if (!byExercise.has(row.exercise_id) && getVideoPlayback(row.video_url)) byExercise.set(row.exercise_id, row.video_url);
  return exercises.map((exercise) => (byExercise.has(exercise.id)
    ? { ...exercise, demo_video_url: byExercise.get(exercise.id), video_origin: 'coach', original_video_url: exercise.demo_video_url || null }
    : exercise));
}