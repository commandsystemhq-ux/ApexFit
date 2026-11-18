// Short looping demos for exercises. Pure decisions only; the component that plays them is src/components/ExerciseMedia.jsx.
//
// What an exercise can show, best first:
//   video   an MP4 or WebM (animation_url) that plays muted in a loop while it is on screen
//   gif     a GIF or animated WebP (animation_url)
//   frames  the real start and end photos of the movement, faded into each other in a loop (image_frames, no extra download)
//   still   the poster photo (thumbnail_url)

export const MAX_ANIMATION_BYTES = 2 * 1024 * 1024;

const VIDEO = /\.(mp4|webm)$/i;
const IMAGE = /\.(gif|webp)$/i;

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function animationKind(value) {
  const url = httpsUrl(value);
  if (!url) return null;
  if (VIDEO.test(url.pathname)) return 'video';
  if (IMAGE.test(url.pathname)) return 'gif';
  return null;
}

export function validFrames(frames) {
  const urls = (Array.isArray(frames) ? frames : []).map(httpsUrl).filter(Boolean).map((url) => url.href);
  return [...new Set(urls)].slice(0, 4);
}

// Slow or metered connections get the light version: the poster only, with a button to load the animation on request.
export function connectionIsLight(connection) {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  return ['slow-2g', '2g', '3g'].includes(connection.effectiveType);
}

// Chooses what to show. `prefs`: light = slow or metered connection, reducedMotion = the user asked for less movement,
// requested = the user pressed the play button. A light connection or reduced motion shows the poster with a play button
// instead of downloading the animation on its own.
export function chooseMedia(exercise, { light = false, reducedMotion = false, requested = false } = {}) {
  const frames = validFrames(exercise?.image_frames);
  const poster = httpsUrl(exercise?.thumbnail_url)?.href || frames[0] || null;
  const kind = animationKind(exercise?.animation_url);

  if (kind) {
    const src = httpsUrl(exercise.animation_url).href;
    if (requested || (!light && !reducedMotion)) return { mode: kind, src, poster };
    return { mode: 'poster', poster, playable: { mode: kind, src } };
  }
  if (frames.length >= 2 && !light && !reducedMotion) return { mode: 'frames', frames, poster };
  if (poster) return { mode: 'still', poster };
  return { mode: 'none' };
}

// An animation is accepted by the importer only when the file is small enough not to cost the user their data.
export async function checkAnimationSize(url, { fetchImpl = fetch, maxBytes = MAX_ANIMATION_BYTES } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
  } catch (error) {
    return { ok: false, reason: `could not be reached (${error.message})` };
  }
  if (!response.ok) return { ok: false, reason: `answered with HTTP ${response.status}` };
  const length = Number(response.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return { ok: false, reason: 'did not report its size' };
  if (length > maxBytes) return { ok: false, reason: `is ${(length / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB` };
  return { ok: true, bytes: length };
}