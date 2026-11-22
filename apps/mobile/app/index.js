import { Redirect } from 'expo-router';
import { Loading } from '../src/components/ui.js';
import { useAuth } from '../src/lib/AuthContext.js';
import { useLocale } from '../src/lib/LocaleContext.js';

// The first screen: wait for the saved session, then go to the app or to sign-in.
export default function Index() {
  const { t } = useLocale();
  const { loading, session, profile } = useAuth();
  if (loading) return <Loading label={t('loading')} />;
  if (!session || !profile) return <Redirect href="/login" />;
  return <Redirect href="/home" />;
}