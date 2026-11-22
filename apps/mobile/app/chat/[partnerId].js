import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams } from 'expo-router';
import VoiceBubble from '../../src/components/VoiceBubble.js';
import VoiceComposer from '../../src/components/VoiceComposer.js';
import { Body, ErrorText, Loading } from '../../src/components/ui.js';
import { useAuth } from '../../src/lib/AuthContext.js';
import { getMessages, markRead, notifyReceiver, sendText, sendVoice, subscribeToChat } from '../../src/lib/chat.js';
import { upsertMessage } from '../../src/lib/format.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { colors, spacing } from '../../src/lib/theme.js';
import { uuid } from '../../src/lib/voice.js';

const MAX_TEXT = 2000;

export default function ChatThread() {
  const { t } = useLocale();
  const { userId } = useAuth();
  const { partnerId, name, active } = useLocalSearchParams();
  const partner = String(partnerId);
  const canSend = active !== '0';
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState('loading');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const read = useCallback(() => { markRead(partner).catch(() => null); }, [partner]);

  useEffect(() => {
    let alive = true;
    getMessages(partner)
      .then((page) => {
        if (!alive) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        setState('ready');
        read();
      })
      .catch(() => { if (alive) setState('error'); });

    const stop = subscribeToChat(userId, (row) => {
      const mine = (row.sender_id === userId && row.receiver_id === partner) || (row.sender_id === partner && row.receiver_id === userId);
      if (!mine || !alive) return;
      setMessages((current) => upsertMessage(current, row));
      if (row.sender_id === partner) read();
    });
    return () => { alive = false; stop(); };
  }, [partner, userId, read]);

  async function loadEarlier() {
    const oldest = messagesRef.current.find((message) => !message.pending);
    if (!oldest) return;
    try {
      const page = await getMessages(partner, oldest.created_at);
      setMessages((current) => page.messages.reduce(upsertMessage, current));
      setHasMore(page.hasMore);
    } catch {
      setError(t('errLoad'));
    }
  }

  async function deliverText(message) {
    try {
      const saved = await sendText(partner, message.message_text, message.client_ref);
      setMessages((current) => upsertMessage(current, saved));
      notifyReceiver(saved.id);
    } catch {
      setMessages((current) => current.map((item) => (item.client_ref === message.client_ref ? { ...item, pending: false, failed: true } : item)));
    }
  }

  function submitText() {
    const text = draft.trim();
    if (!text || text.length > MAX_TEXT) return;
    const pending = {
      id: `pending-${uuid()}`, client_ref: uuid(), sender_id: userId, receiver_id: partner, message_type: 'text',
      message_text: text, created_at: new Date().toISOString(), is_read: false, pending: true,
    };
    setError('');
    setDraft('');
    setMessages((current) => upsertMessage(current, pending));
    deliverText(pending);
  }

  function retry(message) {
    setMessages((current) => current.map((item) => (item.client_ref === message.client_ref ? { ...item, pending: true, failed: false } : item)));
    deliverText(message);
  }

  async function submitVoice({ uri, seconds }) {
    setError('');
    const saved = await sendVoice({ senderId: userId, receiverId: partner, uri, seconds, clientRef: uuid() });
    setMessages((current) => upsertMessage(current, saved));
    notifyReceiver(saved.id);
  }

  const showError = useCallback((key) => setError(t(key)), [t]);
  const data = useMemo(() => [...messages].reverse(), [messages]);

  return (
    <SafeAreaView edges={['bottom']} style={styles.screen}>
      <Stack.Screen options={{ headerShown: true, title: String(name || ''), headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0} style={styles.flex}>
        {state === 'loading' ? <Loading label={t('loading')} /> : null}
        {state === 'error' ? <ErrorText>{t('errLoad')}</ErrorText> : null}
        {state === 'ready' ? (
          <FlatList
            inverted
            data={data}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            onEndReachedThreshold={0.3}
            onEndReached={() => { if (hasMore) loadEarlier(); }}
            renderItem={({ item }) => {
              const mine = item.sender_id === userId;
              const voice = item.message_type === 'voice';
              return (
                <Pressable disabled={!item.failed} onPress={() => retry(item)} style={[styles.bubble, mine ? styles.mine : styles.theirs, item.failed && styles.failed]}>
                  {voice ? <VoiceBubble message={item} /> : <Text style={styles.text}>{item.message_text}</Text>}
                  <Text style={styles.meta}>
                    {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {mine ? (item.failed ? `  ${t('failed')}` : item.pending ? `  ${t('sending')}` : item.is_read ? '  ✓✓' : '  ✓') : ''}
                  </Text>
                </Pressable>
              );
            }}
          />
        ) : null}
        <ErrorText>{error}</ErrorText>
        {canSend ? (
          <View style={styles.composer}>
            {!recording && (
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder={t('chatPlaceholder')}
                placeholderTextColor={colors.subtle}
                multiline
                maxLength={MAX_TEXT}
              />
            )}
            {draft.trim() && !recording ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t('send')} onPress={submitText} style={styles.send}><Text style={styles.sendText}>➤</Text></Pressable>
            ) : (
              <VoiceComposer onSend={submitVoice} onError={showError} onBusyChange={setRecording} />
            )}
          </View>
        ) : <Body subtle style={styles.closed}>{t('chatClosed')}</Body>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  list: { padding: spacing.md, gap: spacing.sm },
  bubble: { maxWidth: '82%', borderRadius: 14, padding: spacing.md, gap: spacing.xs },
  mine: { alignSelf: 'flex-end', backgroundColor: '#1f4f9e' },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.raised },
  failed: { borderWidth: 1, borderColor: colors.danger },
  text: { color: colors.text, fontSize: 15, textAlign: 'auto' },
  meta: { color: colors.subtle, fontSize: 11, alignSelf: 'flex-end' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface },
  input: { flex: 1, maxHeight: 120, minHeight: 44, borderRadius: 22, backgroundColor: colors.background, color: colors.text, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, fontSize: 15, textAlign: 'auto' },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  sendText: { color: '#fff', fontSize: 16 },
  closed: { textAlign: 'center', padding: spacing.lg },
});
