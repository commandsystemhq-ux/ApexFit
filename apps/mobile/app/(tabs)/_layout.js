import { Text } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { useAuth } from '../../src/lib/AuthContext.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { colors } from '../../src/lib/theme.js';

const icon = (glyph) => ({ color }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

// Coaches see their clients and programs; clients see their plan and progress. Chat and settings are for both.
export default function TabsLayout() {
  const { t } = useLocale();
  const { session, profile, role } = useAuth();
  if (!session || !profile) return <Redirect href="/login" />;
  const isCoach = role === 'coach';

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.subtle,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
      }}
    >
      <Tabs.Screen name="home" options={{ title: isCoach ? t('tabClients') : t('tabPlan'), tabBarIcon: icon(isCoach ? '☺' : '↕') }} />
      <Tabs.Screen name="programs" options={{ title: t('tabPrograms'), href: isCoach ? undefined : null, tabBarIcon: icon('❖') }} />
      <Tabs.Screen name="progress" options={{ title: t('tabProgress'), href: isCoach ? null : undefined, tabBarIcon: icon('↗') }} />
      <Tabs.Screen name="chat" options={{ title: t('tabChat'), tabBarIcon: icon('✉') }} />
      <Tabs.Screen name="settings" options={{ title: t('tabSettings'), tabBarIcon: icon('⚙') }} />
    </Tabs>
  );
}
