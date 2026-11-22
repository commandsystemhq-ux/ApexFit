import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Body, Button, Card, Empty, ErrorText, Loading, Screen, Title } from '../../src/components/ui.js';
import { listConversations } from '../../src/lib/chat.js';
import { useAuth } from '../../src/lib/AuthContext.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { colors, spacing } from '../../src/lib/theme.js';

export default function ChatList() {
  const { t } = useLocale();
  const { userId } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems((await listConversations()) || []);
      setError('');
    } catch {
      setError(t('errLoad'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <Screen><Loading label={t('loading')} /></Screen>;

  return (
    <Screen padded={false}>
      <FlatList
        contentContainerStyle={styles.list}
        data={items}
        keyExtractor={(item) => item.partner_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        ListHeaderComponent={<Title>{t('tabChat')}</Title>}
        ListEmptyComponent={error ? <View><ErrorText>{error}</ErrorText><Button title={t('retry')} onPress={load} /></View> : <Empty>{t('noConversations')}</Empty>}
        renderItem={({ item }) => {
          const preview = item.last_type === 'voice' ? `🎤 ${t('voiceMessage')}` : item.last_text || '';
          const unread = Number(item.unread_count) || 0;
          return (
            <Card onPress={() => router.push({ pathname: '/chat/[partnerId]', params: { partnerId: item.partner_id, name: item.partner_name, active: item.status === 'active' ? '1' : '0' } })}>
              <View style={styles.row}>
                <Body>{item.partner_name}</Body>
                {unread > 0 ? <Text style={styles.unread}>{unread > 99 ? '99+' : unread}</Text> : null}
              </View>
              {preview ? <Body subtle>{`${item.last_sender_id === userId ? `${t('you')}: ` : ''}${preview}`}</Body> : null}
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, padding: spacing.lg },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  unread: { minWidth: 22, overflow: 'hidden', borderRadius: 11, backgroundColor: colors.accent, color: '#fff', fontSize: 12, textAlign: 'center', paddingHorizontal: 6, paddingVertical: 2 },
});
