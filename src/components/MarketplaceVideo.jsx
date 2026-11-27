import { useEffect, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getVideoPlayback } from '../services/exerciseVideo.js';

// The coach's intro video. Nothing is loaded from YouTube or Vimeo until the person presses play; only https links to
// YouTube, Vimeo or a video file are ever embedded, anything else shows nothing.
export default function MarketplaceVideo({ url }) {
  const { t } = useLocale();
  const [started, setStarted] = useState(false);
  const playback = getVideoPlayback(url, { autoplay: true });

  useEffect(() => { setStarted(false); }, [url]);
  if (!playback) return null;

  return (
    <div className="mk-video">
      <div className="mk-video-frame">
        {!started && (
          <button type="button" className="mk-video-cover" onClick={() => setStarted(true)} aria-label={t('mkPlayVideo')}>
            <span aria-hidden="true">{'\u25B6'}</span>
            <span>{t('mkPlayVideo')}</span>
          </button>
        )}
        {started && playback.kind === 'iframe' && (
          <iframe src={playback.src} title={t('mkIntroVideoTitle')} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        )}
        {started && playback.kind === 'video' && <video src={playback.src} controls autoPlay playsInline preload="metadata" />}
      </div>
      <a className="text-action" href={playback.watchUrl} target="_blank" rel="noopener noreferrer">{t('mkOpenVideo')}</a>
    </div>
  );
}
