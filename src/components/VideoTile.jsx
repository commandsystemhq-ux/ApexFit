import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';

// One person in the call: their video (or an initial when the camera is off), their name and role, and mic state.
export default function VideoTile({ stream, name, role, local = false, audio = true, video = true, screen = false, connected = true, large = false }) {
  const { t } = useLocale();
  const videoRef = useRef(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream || null;
    if (stream) {
      // A browser may refuse to start sound without a tap; then a play button is shown.
      element.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
    }
  }, [stream]);

  const hasVideo = Boolean(stream) && (video || screen) && stream.getVideoTracks().length > 0;
  const roleLabel = role === 'coach' ? t('rmCoach') : t('rmClient');
  const label = local ? `${t('rmYou')} · ${roleLabel}` : `${name || roleLabel} · ${roleLabel}`;

  return (
    <div className={`video-tile ${large ? 'is-large' : ''} ${local ? 'is-local' : ''} ${connected ? '' : 'is-connecting'}`}>
      <video
        ref={videoRef}
        className={`video-tile-media ${hasVideo ? '' : 'is-hidden'} ${local && !screen ? 'is-mirrored' : ''}`}
        autoPlay
        playsInline
        muted={local}
        aria-label={label}
      />
      {!hasVideo && (
        <div className="video-tile-placeholder" aria-hidden="true">
          <span className="avatar avatar-blue">{(name || roleLabel).slice(0, 1).toUpperCase()}</span>
        </div>
      )}
      {blocked && <button className="video-tile-play" type="button" onClick={() => videoRef.current?.play().then(() => setBlocked(false)).catch(() => {})}>{t('rmTapToPlay')}</button>}
      <div className="video-tile-label">
        <span dir="auto">{label}</span>
        {screen && <span className="video-tile-flag">{t('rmSharingBadge')}</span>}
        {!audio && <span className="video-tile-flag is-muted" title={t('rmMicOffFlag')}>🔇</span>}
      </div>
    </div>
  );
}
