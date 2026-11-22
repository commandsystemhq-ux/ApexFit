import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Body, Button, Card, Empty, ErrorText, Loading, Screen, Title } from '../../src/components/ui.js';
import { listPrograms } from '../../src/lib/data.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { spacing } from '../../src/lib/theme.js';

// The coach's programs (building and assigning them stays in the web app).
export default function Programs() {
  const { t } = useLocale();
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await listPrograms());
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
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        ListHeaderComponent={<Title>{t('tabPrograms')}</Title>}
        ListEmptyComponent={error ? <View><ErrorText>{error}</ErrorText><Button title={t('retry')} onPress={load} /></View> : <Empty>{t('noPrograms')}</Empty>}
        renderItem={({ item }) => (
          <Card onPress={() => router.push({ pathname: '/program/[id]', params: { id: item.id } })}>
            <Body>{item.title}</Body>
            {item.description ? <Body subtle>{item.description}</Body> : null}
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({ list: { flexGrow: 1, padding: spacing.lg } });
