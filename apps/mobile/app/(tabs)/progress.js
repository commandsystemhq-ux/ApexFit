import { useCallback, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Body, Button, Card, Empty, ErrorText, Field, Loading, Screen, Title } from '../../src/components/ui.js';
import { useAuth } from '../../src/lib/AuthContext.js';
import { listBodyMetrics, saveBodyWeight } from '../../src/lib/data.js';
import { parseWeight } from '../../src/lib/format.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { colors, spacing } from '../../src/lib/theme.js';

// The client's follow-up: today's weight and the last entries.
export default function Progress() {
  const { t } = useLocale();
  const { userId } = useAuth();
  const [metrics, setMetrics] = useState([]);
  const [weight, setWeight] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      setMetrics(await listBodyMetrics());
      setError('');
    } catch {
      setError(t('errLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function save() {
    setSaved(false);
    const value = parseWeight(weight);
    if (value === null) {
      setError(t('errWeight'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await saveBodyWeight(userId, value);
      setWeight('');
      setSaved(true);
      await load();
    } catch {
      setError(t('errLoad'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Screen><Loading label={t('loading')} /></Screen>;

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <FlatList
          contentContainerStyle={styles.list}
          data={metrics}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={(
            <View>
              <Title>{t('tabProgress')}</Title>
              <Field label={t('weightKg')} value={weight} onChangeText={setWeight} keyboardType="decimal-pad" />
              <ErrorText>{error}</ErrorText>
              {saved ? <Body style={styles.saved}>{t('savedWeight')}</Body> : null}
              <Button title={t('saveWeight')} onPress={save} loading={saving} />
              <Body subtle style={styles.history}>{t('history')}</Body>
            </View>
          )}
          ListEmptyComponent={<Empty>{t('noMetrics')}</Empty>}
          renderItem={({ item }) => (
            <Card>
              <View style={styles.row}>
                <Body subtle>{item.measured_on}</Body>
                <Body>{item.weight_kg} kg</Body>
              </View>
            </Card>
          )}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { flexGrow: 1, padding: spacing.lg },
  history: { marginTop: spacing.xl, marginBottom: spacing.sm },
  saved: { color: colors.success, marginBottom: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
});
