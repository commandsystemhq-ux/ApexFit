import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Badge, Body, Button, Card, Empty, ErrorText, Loading, Screen, Title } from '../../src/components/ui.js';
import { useAuth } from '../../src/lib/AuthContext.js';
import { listAssignedPrograms, listClients } from '../../src/lib/data.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { spacing } from '../../src/lib/theme.js';

// Coach: the client list. Client: the programs the coach assigned.
export default function Home() {
  const { t } = useLocale();
  const { role } = useAuth();
  const router = useRouter();
  const isCoach = role === 'coach';
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(isCoach ? await listClients() : await listAssignedPrograms());
      setError('');
    } catch {
      setError(t('errLoad'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isCoach, t]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <Screen><Loading label={t('loading')} /></Screen>;

  return (
    <Screen padded={false}>
      <FlatList
        contentContainerStyle={styles.list}
        data={items}
        keyExtractor={(item) => item.id || item.client_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        ListHeaderComponent={<Title>{isCoach ? t('tabClients') : t('tabPlan')}</Title>}
        ListEmptyComponent={error ? <View><ErrorText>{error}</ErrorText><Button title={t('retry')} onPress={load} /></View> : <Empty>{isCoach ? t('noClients') : t('noPlan')}</Empty>}
        renderItem={({ item }) => (isCoach ? (
          <Card>
            <Body>{item.client_name || item.client_email || '—'}</Body>
            {item.client_name ? <Body subtle>{item.client_email}</Body> : null}
            <View style={styles.row}>
              <Badge tone={item.status === 'active' ? 'success' : 'muted'}>{item.status === 'active' ? t('statusActive') : t('statusArchived')}</Badge>
              <Button title={t('openChat')} variant="secondary" onPress={() => router.push({ pathname: '/chat/[partnerId]', params: { partnerId: item.client_id, name: item.client_name || item.client_email || '', active: item.status === 'active' ? '1' : '0' } })} />
            </View>
          </Card>
        ) : (
          <Card onPress={() => item.program && router.push({ pathname: '/program/[id]', params: { id: item.program.id } })}>
            <Body>{item.program?.title}</Body>
            {item.program?.description ? <Body subtle>{item.program.description}</Body> : null}
          </Card>
        ))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, padding: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.sm },
});
