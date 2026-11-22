import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Body, Card, ErrorText, Loading, Screen, Title } from '../../src/components/ui.js';
import { getProgram } from '../../src/lib/data.js';
import { exerciseName } from '../../src/lib/format.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { spacing } from '../../src/lib/theme.js';

export default function ProgramDetail() {
  const { t, locale } = useLocale();
  const { id } = useLocalSearchParams();
  const [program, setProgram] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getProgram(String(id)).then((data) => { if (active) setProgram(data); }).catch(() => { if (active) setError(t('errLoad')); });
    return () => { active = false; };
  }, [id, t]);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: program?.title || '', headerStyle: { backgroundColor: '#111a2e' }, headerTintColor: '#e5e7eb' }} />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {!program && !error ? <Loading label={t('loading')} /> : null}
      {program ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Title>{program.title}</Title>
          {program.description ? <Body subtle>{program.description}</Body> : null}
          {program.days.map((day) => (
            <Card key={day.id}>
              <Body>{day.name}</Body>
              {day.exercises.map((entry) => (
                <View key={entry.id} style={styles.exercise}>
                  <Body>{exerciseName(entry.exercise, locale)}</Body>
                  <Body subtle>
                    {entry.sets} {t('sets')} × {entry.reps} {t('reps')}{entry.rest_seconds ? ` · ${t('rest')} ${entry.rest_seconds}${t('seconds')}` : ''}
                  </Body>
                  {entry.notes ? <Body subtle>{entry.notes}</Body> : null}
                </View>
              ))}
            </Card>
          ))}
        </ScrollView>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  exercise: { marginTop: spacing.md },
});
