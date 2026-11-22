import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Body, Button, ErrorText, Field, Screen, Title } from '../src/components/ui.js';
import { useAuth } from '../src/lib/AuthContext.js';
import { isConfigured } from '../src/lib/config.js';
import { useLocale } from '../src/lib/LocaleContext.js';
import { colors, spacing } from '../src/lib/theme.js';
import { LOCALE_NAMES, SUPPORTED_LOCALES } from '../src/lib/translations.js';

export default function Login() {
  const { t, locale, setLocale } = useLocale();
  const { session, profile, signInWithPassword, signUpWithPassword, signInWithGoogle } = useAuth();
  const [mode, setMode] = useState('signin');
  const [role, setRole] = useState('client');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  if (session && profile) return <Redirect href="/home" />;

  async function submit() {
    setError('');
    setInfo('');
    if (!email.trim() || !password) {
      setError(t('errRequired'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signInWithPassword(email, password);
      } else if (!(await signUpWithPassword({ email, password, fullName, role }))) {
        setInfo(t('checkEmail'));
        setMode('signin');
      }
    } catch (failure) {
      setError(mode === 'signin' ? t('errCredentials') : failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError('');
    setBusy(true);
    try {
      await signInWithGoogle(mode === 'signup' ? role : null);
    } catch (failure) {
      if (failure.message !== 'cancelled') setError(t('authFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>{t('appName')}</Text>
          <Title>{mode === 'signin' ? t('signIn') : t('signUp')}</Title>
          {!isConfigured && <ErrorText>{t('errConfig')}</ErrorText>}
          {mode === 'signup' && (
            <>
              <Field label={t('fullName')} value={fullName} onChangeText={setFullName} autoCapitalize="words" textContentType="name" />
              <Body subtle>{t('iAmA')}</Body>
              <View style={styles.roles}>
                {['client', 'coach'].map((value) => (
                  <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: role === value }} onPress={() => setRole(value)} style={[styles.role, role === value && styles.roleOn]}>
                    <Text style={styles.roleText}>{t(value === 'client' ? 'roleClient' : 'roleCoach')}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          <Field label={t('email')} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
          <Field label={t('password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" />
          <ErrorText>{error}</ErrorText>
          {info ? <Body style={styles.info}>{info}</Body> : null}
          <Button title={mode === 'signin' ? t('signIn') : t('signUp')} onPress={submit} loading={busy} disabled={!isConfigured} />
          <Body subtle style={styles.or}>{t('or')}</Body>
          <Button title={t('continueGoogle')} variant="secondary" onPress={google} disabled={busy || !isConfigured} />
          <Pressable accessibilityRole="button" onPress={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }} style={styles.switch}>
            <Text style={styles.link}>{mode === 'signin' ? t('createInstead') : t('signInInstead')}</Text>
          </Pressable>
          <View style={styles.languages}>
            {SUPPORTED_LOCALES.map((code) => (
              <Pressable key={code} accessibilityRole="button" onPress={() => setLocale(code)}><Text style={[styles.language, code === locale && styles.languageOn]}>{LOCALE_NAMES[code]}</Text></Pressable>
            ))}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: spacing.xl },
  brand: { color: colors.accent, fontSize: 14, fontWeight: '700', letterSpacing: 2, marginBottom: spacing.sm },
  roles: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.sm, marginBottom: spacing.md },
  role: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  roleOn: { borderColor: colors.accent, backgroundColor: colors.raised },
  roleText: { color: colors.text },
  info: { color: colors.success, marginBottom: spacing.sm },
  or: { textAlign: 'center', marginVertical: spacing.md },
  switch: { alignItems: 'center', padding: spacing.md },
  link: { color: colors.accent, fontSize: 15 },
  languages: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md, marginTop: spacing.lg },
  language: { color: colors.subtle, fontSize: 13 },
  languageOn: { color: colors.text, fontWeight: '700' },
});
