import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { chooseMedia, connectionIsLight } from '../services/exerciseMedia.js';

// Looping demo of an exercise. Costs as little data as possible:
// - nothing is downloaded until the card is near the screen, and a video is paused again when it leaves;
// - slow or "save data" connections, and people who asked for less motion, get the poster and a play button;
// - the poster photo stays visible until the animation really plays, and comes back if the animation fails.
function usePreferences() {
  const [prefs, setPrefs] = useState({ light: false, reducedMotion: false });

  useEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const connection = navigator.connection;
    const read = () => setPrefs({ light: connectionIsLight(connection), reducedMotion: Boolean(motion?.matches) });
    read();
    motion?.addEventListener?.('change', read);
    connection?.addEventListener?.('change', read);
    return () => {
      motion?.removeEventListener?.('change', read);
      connection?.removeEventListener?.('change', read);
    };
  }, []);

  return prefs;
}

function useNearScreen(ref) {
  const [near, setNear] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      setOnScreen(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry.isIntersecting) setNear(true);
      setOnScreen(entry.isIntersecting);
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return { near, onScreen };
}

function LoopVideo({ src, poster, onFail, onScreen }) {
  const video = useRef(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (onScreen) node.play?.().catch(() => {});
    else node.pause?.();
  }, [onScreen]);

  return (
    <video
      ref={video}
      className={`exercise-media-layer exercise-media-video ${playing ? 'is-ready' : ''}`}
      src={src}
      poster={poster || undefined}
      muted
      loop
      playsInline
      autoPlay
      preload="metadata"
      disablePictureInPicture
      aria-hidden="true"
      onPlaying={() => setPlaying(true)}
      onError={onFail}
    />
  );
}

export default function ExerciseMedia({ exercise, large = false }) {
  const { t } = useLocale();
  const box = useRef(null);
  const prefs = usePreferences();
  const { near, onScreen } = useNearScreen(box);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [gifReady, setGifReady] = useState(false);

  const choice = chooseMedia(failed ? { ...exercise, animation_url: null } : exercise, { ...prefs, requested });
  if (choice.mode === 'none') return null;

  const poster = choice.poster;
  const frames = choice.mode === 'frames' ? choice.frames : [];
  const playingFrames = choice.mode === 'frames' && onScreen && frameReady;

  return (
    <div ref={box} className={`exercise-media ${large ? 'exercise-media-large' : ''} ${playingFrames ? 'is-playing' : ''}`} data-mode={choice.mode}>
      {poster && near && (
        <img
          className="exercise-media-layer"
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
      {choice.mode === 'frames' && near && frames[1] && (
        <img
          className="exercise-media-layer exercise-media-frame-b"
          src={frames[1]}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setFrameReady(true)}
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
      {choice.mode === 'gif' && near && onScreen && (
        <img
          className={`exercise-media-layer exercise-media-gif ${gifReady ? 'is-ready' : ''}`}
          src={choice.src}
          alt=""
          decoding="async"
          onLoad={() => setGifReady(true)}
          onError={() => setFailed(true)}
        />
      )}
      {choice.mode === 'video' && near && (
        <LoopVideo src={choice.src} poster={poster} onScreen={onScreen} onFail={() => setFailed(true)} />
      )}
      {choice.mode === 'poster' && choice.playable && (
        <button className="exercise-media-play" type="button" onClick={() => setRequested(true)}>
          <span aria-hidden="true">{'\u25B6'}</span> {t('exerciseMediaPlay')}
        </button>
      )}
    </div>
  );
}