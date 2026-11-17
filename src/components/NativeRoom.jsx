import VideoTile from './VideoTile.jsx';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useVideoRoom } from '../hooks/useVideoRoom.js';
import { statusKey } from '../services/webrtcRoom.js';

const MEDIA_ERRORS = {
  denied: ['rmErr_denied', 'rmErr_deniedHelp'],
  notFound: ['rmErr_notFound', 'rmErr_notFoundHelp'],
  inUse: ['rmErr_inUse', 'rmErr_inUseHelp'],
  insecure: ['rmErr_insecure', 'rmErr_insecureHelp'],
  unsupported: ['rmErr_unsupported', 'rmErr_unsupportedHelp'],
  failed: ['rmErr_failed', 'rmErr_failedHelp'],
};

// The native video room: the other person fills the screen, you are in a small corner window, and the controls
// sit at the bottom. Several people share the space as a grid.
export default function NativeRoom({ sessionId, userId, name, coachId, selfRole, onEnd }) {
  const { t } = useLocale();
  const { media, snapshot, retry, toggleAudio, toggleVideo, toggleShare, canShare, leave } = useVideoRoom({ sessionId, userId, name, coachId });

  async function endCall() {
    await leave();
    onEnd();
  }

  if (media.phase === 'error') {
    const [titleKey, helpKey] = MEDIA_ERRORS[media.error] || MEDIA_ERRORS.failed;
    return (
      <main className="live-room-message" role="alert">
        <h1>{t(titleKey)}</h1>
        <p>{t(helpKey)}</p>
        <Button variant="primary" onClick={retry}>{t('rmRetry')}</Button>
      </main>
    );
  }

  if (snapshot.status === 'error') {
    const kind = snapshot.error?.kind;
    return (
      <main className="live-room-message" role="alert">
        <h1>{t(kind === 'full' ? 'rmErr_full' : kind === 'unauthorized' ? 'rmErr_unauthorized' : 'rmErr_signaling')}</h1>
        <p>{t(kind === 'full' ? 'rmErr_fullHelp' : kind === 'unauthorized' ? 'rmErr_unauthorizedHelp' : 'rmErr_signalingHelp')}</p>
        {kind !== 'full' && snapshot.error?.message && (
          <p className="room-error-detail" dir="ltr"><strong>{t('rmErrDetails')}:</strong> <code>{snapshot.error.message}</code></p>
        )}
        <Button variant="primary" onClick={retry}>{t('rmRetry')}</Button>
      </main>
    );
  }

  const { peers } = snapshot;
  const connectedNow = snapshot.status === 'connected';
  const chip = statusKey(snapshot);

  return (
    <main className="native-room">
      <div className={`room-status ${connectedNow ? 'is-connected' : ''}`} role="status" aria-live="polite">
        <span className="room-status-dot" aria-hidden="true">{connectedNow ? '🟢' : '🟡'}</span>
        <span>{t(chip)}</span>
        {peers.length > 0 && <span className="room-status-count">{peers.length + 1} {t('rmParticipants')}</span>}
      </div>

      <div className={`room-grid count-${Math.min(peers.length, 5)}`}>
        {peers.length === 0 && (
          <div className="room-empty">
            <span className="room-pulse" aria-hidden="true" />
            <p>{t('rmWaiting')}</p>
          </div>
        )}
        {peers.map((peer) => (
          <VideoTile
            key={peer.id}
            stream={peer.stream}
            name={peer.name}
            role={peer.role}
            audio={peer.audio}
            video={peer.video}
            screen={peer.screen}
            connected={peer.connected}
            large={peers.length === 1}
          />
        ))}
      </div>

      <div className="room-self">
        <VideoTile stream={snapshot.localStream} name={name} role={selfRole} local audio={snapshot.audioEnabled} video={snapshot.videoEnabled || snapshot.sharing} screen={snapshot.sharing} />
      </div>

      {snapshot.audioOnly && <p className="room-note">{t('rmAudioOnly')}</p>}

      <div className="room-controls" role="toolbar" aria-label={t('rmControls')}>
        <button className={`room-control ${snapshot.audioEnabled ? '' : 'is-off'}`} type="button" aria-pressed={!snapshot.audioEnabled} onClick={toggleAudio}>
          <span aria-hidden="true">{snapshot.audioEnabled ? '🎤' : '🔇'}</span>
          <span>{snapshot.audioEnabled ? t('rmMute') : t('rmUnmute')}</span>
        </button>
        <button className={`room-control ${snapshot.videoEnabled ? '' : 'is-off'}`} type="button" aria-pressed={!snapshot.videoEnabled} disabled={snapshot.audioOnly} onClick={toggleVideo}>
          <span aria-hidden="true">{snapshot.videoEnabled ? '📷' : '🚫'}</span>
          <span>{snapshot.videoEnabled ? t('rmCameraOff') : t('rmCameraOn')}</span>
        </button>
        {canShare && (
          <button className={`room-control ${snapshot.sharing ? 'is-active' : ''}`} type="button" aria-pressed={snapshot.sharing} onClick={toggleShare}>
            <span aria-hidden="true">🖥️</span>
            <span>{snapshot.sharing ? t('rmStopShare') : t('rmShare')}</span>
          </button>
        )}
        <button className="room-control is-end" type="button" onClick={endCall}>
          <span aria-hidden="true">📞</span>
          <span>{t('lrEndCall')}</span>
        </button>
      </div>
    </main>
  );
}
