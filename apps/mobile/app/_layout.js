import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../src/lib/AuthContext.js';
import { LocaleProvider } from '../src/lib/LocaleContext.js';
import { colors } from '../src/lib/theme.js';

export default function RootLayout() {
  return (
    <LocaleProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
      </AuthProvider>
    </LocaleProvider>
  );
}