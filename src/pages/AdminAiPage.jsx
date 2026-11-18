import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import PlatformAiPanel from '../components/PlatformAiPanel.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getAiStatus } from '../services/aiSettingsService.js';
import { AUTH_PATHS } from '../routes.js';

// /admin/ai: the platform owner's AI provider. Anyone else is sent away as if the page did not exist.
export default function AdminAiPage() {
  const { t } = useLocale();
  const [state, setState] = useState('checking');

  useEffect(() => {
    let active = true;
    getAiStatus()
      .then((status) => { if (active) setState(status.admin ? 'admin' : 'denied'); })
      .catch(() => { if (active) setState('denied'); });
    return () => { active = false; };
  }, []);

  if (state === 'denied') return <Navigate to={AUTH_PATHS.home} replace />;
  if (state === 'checking') return <div className="empty-state" role="status">{t('loadingProgress')}</div>;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('adminAiTitle')} description={t('adminAiDescription')} />
      <div className="settings-stack"><PlatformAiPanel /></div>
    </>
  );
}
