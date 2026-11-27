import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../components/Button.jsx';
import EmailPreferences from '../components/EmailPreferences.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ProfileSettings from '../components/ProfileSettings.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getAiStatus } from '../services/aiSettingsService.js';
import { isPlatformAdmin } from '../services/marketplaceService.js';
import { ADMIN_PATHS } from '../routes.js';

export default function SettingsPage() {
  const { t } = useLocale();
  const { user, profile, signOut } = useAuth();
  // The AI provider is chosen by the platform owner for the whole platform. Only the owner is told about it;
  // for everyone else this stays false and nothing about AI appears on this page.
  const [platformAdmin, setPlatformAdmin] = useState(false);
  // The marketplace moderation screen is open to the owners listed in the database (platform_admins).
  const [marketplaceAdmin, setMarketplaceAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    getAiStatus().then((status) => { if (active) setPlatformAdmin(Boolean(status.admin)); }).catch(() => {});
    isPlatformAdmin().then((admin) => { if (active) setMarketplaceAdmin(admin === true); }).catch(() => {});
    return () => { active = false; };
  }, [user?.id]);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('settingsTitle')} description={t('settingsDescription')} />
      <div className="settings-stack">
        <ProfileSettings />
        <section className="panel settings-panel">
          <div className="settings-row">
            <div><h3>{t('language')}</h3><p>{t('languageHelp')}</p></div>
            <LanguageToggle />
          </div>
          <div className="settings-row">
            <div><h3>{t('themeLabel')}</h3><p>{t('themeHelp')}</p></div>
            <ThemeToggle />
          </div>
          <div className="settings-row">
            <div><h3>{t('account')}</h3><p>{user?.email || t('signedOut')}</p></div>
            <span className="soft-badge badge-blue">{profile ? t(profile.role) : t('signedOut')}</span>
          </div>
          {profile?.role === 'client' && <EmailPreferences />}
          {platformAdmin && (
            <div className="settings-row">
              <div><h3>{t('adminAiLink')}</h3><p>{t('adminAiLinkHelp')}</p></div>
              <Link className="button button-secondary" to={ADMIN_PATHS.ai}>{t('adminAiOpen')}</Link>
            </div>
          )}
          {marketplaceAdmin && (
            <div className="settings-row">
              <div><h3>{t('adminMkLink')}</h3><p>{t('adminMkLinkHelp')}</p></div>
              <Link className="button button-secondary" to={ADMIN_PATHS.marketplace}>{t('adminAiOpen')}</Link>
            </div>
          )}
          <Button variant="secondary" onClick={signOut}>{t('signOut')}</Button>
        </section>
      </div>
    </>
  );
}
