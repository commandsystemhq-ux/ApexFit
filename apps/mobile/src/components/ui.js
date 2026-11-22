import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing } from '../lib/theme.js';

export function Screen({ children, padded = true }) {
  return <SafeAreaView edges={['top']} style={styles.screen}><View style={[styles.fill, padded && styles.padded]}>{children}</View></SafeAreaView>;
}

export function Title({ children }) {
  return <Text accessibilityRole="header" style={styles.title}>{children}</Text>;
}

export function Body({ children, subtle, style }) {
  return <Text style={[styles.body, subtle && styles.subtle, style]}>{children}</Text>;
}

export function Button({ title, onPress, disabled, loading, variant = 'primary' }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading) }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [styles.button, variant === 'secondary' && styles.buttonSecondary, (disabled || loading) && styles.disabled, pressed && styles.pressed]}
    >
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.subtle} style={styles.input} {...props} />
    </View>
  );
}

export function Card({ children, onPress }) {
  const content = <View style={styles.card}>{children}</View>;
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress}>{content}</Pressable> : content;
}

export function Badge({ children, tone = 'muted' }) {
  return <Text style={[styles.badge, tone === 'success' && styles.badgeSuccess]}>{children}</Text>;
}

export function ErrorText({ children }) {
  return children ? <Text accessibilityRole="alert" style={styles.error}>{children}</Text> : null;
}

export function Loading({ label }) {
  return <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text style={[styles.body, styles.subtle]}>{label}</Text></View>;
}

export function Empty({ children }) {
  return <View style={styles.center}><Text style={[styles.body, styles.subtle, styles.centerText]}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  padded: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: spacing.md },
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  subtle: { color: colors.subtle },
  button: { alignItems: 'center', justifyContent: 'center', minHeight: 46, borderRadius: 10, backgroundColor: colors.accent, paddingHorizontal: spacing.lg },
  buttonSecondary: { backgroundColor: colors.raised },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  field: { marginBottom: spacing.md },
  label: { color: colors.subtle, fontSize: 13, marginBottom: spacing.xs, textAlign: 'auto' },
  input: { minHeight: 46, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: spacing.md, fontSize: 15, textAlign: 'auto' },
  card: { borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: spacing.md, marginBottom: spacing.sm },
  badge: { alignSelf: 'flex-start', overflow: 'hidden', borderRadius: 6, backgroundColor: colors.raised, color: colors.subtle, fontSize: 11, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeSuccess: { color: colors.success },
  error: { color: colors.danger, fontSize: 13, marginVertical: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  centerText: { textAlign: 'center' },
});