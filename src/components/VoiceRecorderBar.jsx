import VoicePlayer from './VoicePlayer.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { VOICE_MAX_SECONDS, formatVoiceDuration } from '../services/voiceUtils.js';

// Replaces the text box while a voice message is being recorded or previewed.
export default function VoiceRecorderBar({ recorder, onSend }) {
  const { t } = useLocale();
  const { state, seconds, recording } = recorder;

  if (state === 'requesting') {
    return <div className="voice-bar" role="status">{t('voiceAllowMic')}</div>;
  }

  if (state === 'recording') {
    return (
      <div className="voice-bar is-recording">
        <span className="voice-dot" aria-hidden="true" />
        <span className="voice-elapsed" role="timer" aria-label={t('voiceRecording')} dir="ltr">
          {formatVoiceDuration(seconds)} / {formatVoiceDuration(VOICE_MAX_SECONDS)}
        </span>
        <span className="voice-hint">{t('voiceRecording')}</span>
        <button className="text-action" type="button" onClick={recorder.reset}>{t('voiceCancel')}</button>
        <button className="chat-send voice-stop" type="button" onClick={recorder.stop} aria-label={t('voiceStop')} title={t('voiceStop')}>
          <span aria-hidden="true">■</span>
        </button>
      </div>
    );
  }

  if (state === 'preview' && recording) {
    return (
      <div className="voice-bar is-preview">
        <VoicePlayer src={recording.url} duration={recording.seconds} />
        <button className="text-action" type="button" onClick={recorder.reset}>{t('voiceDiscard')}</button>
        <button className="chat-send" type="button" onClick={onSend} aria-label={t('chatSend')} title={t('chatSend')}>
          <span aria-hidden="true">➤</span>
        </button>
      </div>
    );
  }

  return null;
}
