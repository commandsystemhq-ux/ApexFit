import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Button, ErrorText, Loading, Screen } from '../../src/components/ui.js';
import { completeFromUrl } from '../../src/lib/AuthContext.js';
import { useLocale } from '../../src/lib/LocaleContext.js';
import { supabase } from '../../src/lib/supabase.js';

// apexfit://auth/callback: where the sign-in page and the confirmation email send the person back to the app.
export default function AuthCallback() {
  const { t } = useLocale();
  const router = useRouter();
  const url = Linking.useURL();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url || !supabase) return;
    completeFromUrl(supabase, url)
      .then(() => router.replace('/'))
      .catch(() => setFailed(true));
  }, [url, router]);

  if (!failed) return <Loading label={t('loading')} />;
  return (
    <Screen>
      <ErrorText>{t('authFailed')}</ErrorText>
      <Button title={t('signIn')} onPress={() => router.replace('/login')} />
    </Screen>
  );
}
