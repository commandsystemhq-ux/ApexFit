import Button from '../components/Button.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function SettingsPage({ user, profile, onSignOut }) {
  const { t } = useLocale();

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('settingsTitle')} description={t('settingsDescription')} />
      <section className="panel settings-panel">
        <div className="settings-row">
          <div><h3>{t('language')}</h3><p>{t('languageHelp')}</p></div>
          <LanguageToggle />
        </div>
        <div className="settings-row">
          <div><h3>{t('account')}</h3><p>{user?.email || t('signedOut')}</p></div>
          <span className="soft-badge badge-blue">{profile ? t(profile.role) : t('signedOut')}</span>
        </div>
        {user && <Button variant="secondary" onClick={onSignOut}>{t('signOut')}</Button>}
      </section>
    </>
  );
}
