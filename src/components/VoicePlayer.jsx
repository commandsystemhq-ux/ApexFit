import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { formatVoiceDuration } from '../services/voiceUtils.js';

// A small audio player for one voice message. Give it `src` (a local preview) or `loadSource` (asks for a short-lived
// signed link when the person presses play, and again if the link has expired).
export default function VoicePlayer({ duration, src = '', loadSource = null }) {
  const { t } = useLocale();
  const audioRef = useRef(null);
  const playAfterLoad = useRef(false);
  const [url, setUrl] = useState(src);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const total = Number(duration) || 0;

  useEffect(() => {
    setUrl(src);
    setCurrent(0);
    setPlaying(false);
  }, [src]);

  useEffect(() => {
    if (url && playAfterLoad.current && audioRef.current) {
      playAfterLoad.current = false;
      audioRef.current.play().catch(() => setFailed(true));
    }
  }, [url]);

  async function toggle() {
    setFailed(false);
    const audio = audioRef.current;
    if (url && audio) {
      if (audio.paused) audio.play().catch(() => setFailed(true));
      else audio.pause();
      return;
    }
    if (!loadSource) return;
    setLoading(true);
    try {
      playAfterLoad.current = true;
      setUrl(await loadSource());
    } catch {
      playAfterLoad.current = false;
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  function seek(event) {
    const value = Number(event.target.value);
    setCurrent(value);
    if (audioRef.current && url) audioRef.current.currentTime = value;
  }

  // An expired link makes the audio fail: forget it so the next press asks for a fresh one.
  function onError() {
    setPlaying(false);
    setFailed(true);
    if (loadSource) setUrl('');
  }

  return (
    <div className="voice-player" dir="ltr">
      <button className="voice-play" type="button" onClick={toggle} disabled={loading} aria-label={playing ? t('voicePause') : t('voicePlay')} title={playing ? t('voicePause') : t('voicePlay')}>
        <span aria-hidden="true">{loading ? '…' : playing ? '❚❚' : '▶'}</span>
      </button>
      <input
        className="voice-progress"
        type="range"
        min="0"
        max={total || 1}
        step="0.1"
        value={Math.min(current, total || 1)}
        onChange={seek}
        aria-label={t('voiceProgress')}
      />
      <span className="voice-time">{formatVoiceDuration(playing || current > 0 ? current : total)}{(playing || current > 0) && total ? ` / ${formatVoiceDuration(total)}` : ''}</span>
      {failed && <small className="voice-error" role="alert">{t('voicePlayError')}</small>}
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCurrent(0); }}
          onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
          onError={onError}
        />
      )}
    </div>
  );
}
