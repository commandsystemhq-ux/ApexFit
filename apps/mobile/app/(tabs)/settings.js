import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Screen, Title } from '../../src/components/ui.js';
import { useAuth } from '../../src/lib/AuthContext.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { colors, spacing } from '../../src/lib/theme.js';
import { LOCALE_NAMES, SUPPORTED_LOCALES } from '../../src/lib/translations.js';

export default function Settings() {
  const { t, locale, setLocale, directionChanged } = useLocale();
  const { session, role, signOut } = useAuth();

  return (
    <Screen>
      <ScrollView>
        <Title>{t('tabSettings')}</Title>
        <Card>
          <Body subtle>{t('account')}</Body>
          <Body>{session?.user?.email}</Body>
          <Body subtle>{t('role')}: {role === 'coach' ? t('roleCoach') : t('roleClient')}</Body>
        </Card>
        <Card>
          <Body subtle>{t('language')}</Body>
          <View style={styles.languages}>
            {SUPPORTED_LOCALES.map((code) => (
              <Pressable key={code} accessibilityRole="radio" accessibilityState={{ selected: code === locale }} onPress={() => setLocale(code)} style={[styles.language, code === locale && styles.languageOn]}>
                <Text style={styles.languageText}>{LOCALE_NAMES[code]}</Text>
              </Pressable>
            ))}
          </View>
          {directionChanged ? <Body style={styles.note}>{t('restartForDirection')}</Body> : null}
        </Card>
        <Button title={t('signOut')} variant="secondary" onPress={signOut} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  language: { borderRadius: 8, borderWidth: 1, borderColor: colors.line, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  languageOn: { borderColor: colors.accent, backgroundColor: colors.raised },
  languageText: { color: colors.text },
  note: { color: colors.subtle, marginTop: spacing.md, fontSize: 13 },
});
