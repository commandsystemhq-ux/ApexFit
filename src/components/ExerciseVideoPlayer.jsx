import { useEffect, useState } from 'react';
import ExerciseMedia from './ExerciseMedia.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import { getVideoPlayback, providerLabel } from '../services/exerciseVideo.js';

// The demo video of an exercise. Nothing is loaded from YouTube or Vimeo until the person presses play (so a page full
// of exercises stays light and private); YouTube plays from youtube-nocookie.com and Vimeo with do-not-track. The
// picture of the exercise is the cover, and it is what is shown when there is no video or the video cannot play.
export default function ExerciseVideoPlayer({ exercise, url, large = false, autoPlay = false }) {
  const { t } = useLocale();
  const [started, setStarted] = useState(autoPlay);
  const [failed, setFailed] = useState(false);
  const link = url ?? exercise?.demo_video_url;
  const playback = getVideoPlayback(link, { autoplay: true });

  useEffect(() => {
    setStarted(autoPlay);
    setFailed(false);
  }, [link, autoPlay]);

  if (!playback || failed) {
    return (
      <div className="exercise-video-fallback">
        <ExerciseMedia exercise={exercise} large={large} />
        {failed && <p className="muted-copy" role="status">{t('evUnavailable')}</p>}
      </div>
    );
  }

  const cover = exercise?.thumbnail_url || exercise?.image_frames?.[0] || '';
  return (
    <div className="exercise-video-player">
      <div className="exercise-video-frame">
        {!started && (
          <button type="button" className="exercise-video-cover" onClick={() => setStarted(true)} aria-label={t('evPlay')} style={cover ? { backgroundImage: `url("${cover}")` } : undefined}>
            <span className="exercise-video-play" aria-hidden="true">{'\u25B6'}</span>
            <span className="exercise-video-label">{t('evPlay')}</span>
          </button>
        )}
        {started && playback.kind === 'iframe' && (
          <iframe
            className="exercise-video"
            src={playback.src}
            title={exercise?.name || t('demoVideo')}
            loading="lazy"
            allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            allowFullScreen
          />
        )}
        {started && playback.kind === 'video' && (
          <video className="exercise-video" src={playback.src} poster={cover || undefined} controls playsInline autoPlay preload="metadata" onError={() => setFailed(true)}>
            {t('videoUnsupported')}
          </video>
        )}
      </div>
      <a className="text-action exercise-video-external" href={playback.watchUrl} target="_blank" rel="noopener noreferrer">
        {fillText(t('evOpenExternal'), { provider: providerLabel(playback.provider) })}
      </a>
    </div>
  );
}