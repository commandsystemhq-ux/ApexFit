import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { getVoiceUrl } from '../lib/chat.js';
import { useLocale } from '../lib/LocaleContext.js';
import { colors, spacing } from '../lib/theme.js';
import { formatVoiceDuration } from '../lib/voice.js';

// Plays one voice message. The signed link is requested when the person presses play (and again if it has expired),
// and is never stored.
export default function VoiceBubble({ message }) {
  const { t } = useLocale();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const loaded = useRef(false);
  const total = Number(message.audio_duration_seconds) || 0;

  useEffect(() => {
    if (status.didJustFinish) player.seekTo(0).catch(() => null);
  }, [status.didJustFinish, player]);

  async function toggle() {
    setFailed(false);
    try {
      if (status.playing) {
        player.pause();
        return;
      }
      if (!loaded.current) {
        setLoading(true);
        player.replace({ uri: await getVoiceUrl(message.audio_path) });
        loaded.current = true;
      }
      player.play();
    } catch {
      loaded.current = false;
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  const shown = status.playing || status.currentTime > 0 ? status.currentTime : total;
  const progress = total ? Math.min(1, status.currentTime / total) : 0;

  return (
    <View>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? t('voicePause') : t('voicePlay')} disabled={loading} onPress={toggle} style={styles.play}>
          <Text style={styles.playText}>{loading ? '…' : status.playing ? '❚❚' : '▶'}</Text>
        </Pressable>
        <View style={styles.track}><View style={[styles.fill, { width: `${Math.round(progress * 100)}%` }]} /></View>
        <Text style={styles.time}>{formatVoiceDuration(shown)}</Text>
      </View>
      {failed && <Text style={styles.error}>{t('voiceErrPlay')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 190 },
  play: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  playText: { color: '#fff', fontSize: 12 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.text },
  time: { color: colors.subtle, fontSize: 11, minWidth: 34 },
  error: { color: colors.danger, fontSize: 11, marginTop: spacing.xs },
});