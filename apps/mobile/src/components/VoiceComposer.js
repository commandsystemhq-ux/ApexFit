import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import { useLocale } from '../lib/LocaleContext.js';
import { colors, spacing } from '../lib/theme.js';
import { VOICE_MAX_SECONDS, formatVoiceDuration } from '../lib/voice.js';

// Microphone button, recording bar and a preview with Send and Cancel. `onSend({ uri, seconds })` does the upload.
export default function VoiceComposer({ onSend, onError, onBusyChange }) {
  const { t } = useLocale();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [state, setState] = useState('idle'); // idle | recording | preview | sending
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState(null);
  const startedAt = useRef(0);
  const timer = useRef(null);
  const player = useAudioPlayer(clip?.uri ? { uri: clip.uri } : null);
  const playing = useAudioPlayerStatus(player).playing;

  const stopTimer = useCallback(() => {
    clearInterval(timer.current);
    timer.current = null;
  }, []);

  const finish = useCallback(async () => {
    stopTimer();
    const elapsed = Math.min((Date.now() - startedAt.current) / 1000, VOICE_MAX_SECONDS);
    try {
      await recorder.stop();
    } catch {
      // A recorder that already stopped is fine.
    }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => null);
    if (recorder.uri) {
      setClip({ uri: recorder.uri, seconds: Math.round(elapsed) });
      setSeconds(elapsed);
      setState('preview');
    } else {
      setState('idle');
      onError('voiceErrRecord');
    }
  }, [recorder, stopTimer, onError]);

  useEffect(() => () => stopTimer(), [stopTimer]);

  useEffect(() => { onBusyChange?.(state !== 'idle'); }, [state, onBusyChange]);

  async function start() {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        onError('voiceDenied');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
      setSeconds(0);
      setState('recording');
      timer.current = setInterval(() => {
        const elapsed = (Date.now() - startedAt.current) / 1000;
        setSeconds(Math.min(elapsed, VOICE_MAX_SECONDS));
        if (elapsed >= VOICE_MAX_SECONDS) finish();
      }, 250);
    } catch {
      stopTimer();
      setState('idle');
      onError('voiceErrRecord');
    }
  }

  async function cancel() {
    stopTimer();
    if (state === 'recording') await recorder.stop().catch(() => null);
    player.pause();
    setClip(null);
    setState('idle');
  }

  async function send() {
    if (!clip) return;
    setState('sending');
    try {
      await onSend(clip);
      setClip(null);
      setState('idle');
    } catch (error) {
      setState('preview');
      onError(error?.key || 'voiceErrUpload', error);
    }
  }

  if (state === 'idle') {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={t('voiceRecord')} onPress={start} style={styles.mic}>
        <Text style={styles.micText}>🎤</Text>
      </Pressable>
    );
  }

  if (state === 'recording') {
    return (
      <View style={styles.bar}>
        <View style={styles.dot} />
        <Text style={styles.time}>{formatVoiceDuration(seconds)} / {formatVoiceDuration(VOICE_MAX_SECONDS)}</Text>
        <Pressable accessibilityRole="button" onPress={cancel}><Text style={styles.link}>{t('voiceCancel')}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('voiceStop')} onPress={finish} style={[styles.round, styles.stop]}><Text style={styles.micText}>■</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.bar}>
      <Pressable accessibilityRole="button" accessibilityLabel={playing ? t('voicePause') : t('voicePlay')} onPress={() => (playing ? player.pause() : player.play())} style={styles.round}>
        <Text style={styles.micText}>{playing ? '❚❚' : '▶'}</Text>
      </Pressable>
      <Text style={styles.time}>{formatVoiceDuration(clip?.seconds ?? seconds)}</Text>
      <Pressable accessibilityRole="button" disabled={state === 'sending'} onPress={cancel}><Text style={styles.link}>{t('voiceCancel')}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t('voiceSend')} disabled={state === 'sending'} onPress={send} style={[styles.round, state === 'sending' && styles.disabled]}>
        <Text style={styles.micText}>{state === 'sending' ? '…' : '➤'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  mic: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  micText: { color: '#fff', fontSize: 16 },
  bar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  time: { flex: 1, color: colors.text, fontSize: 14 },
  link: { color: colors.subtle, fontSize: 14 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  stop: { backgroundColor: colors.danger },
  disabled: { opacity: 0.5 },
});