import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import PlatformIntegrationsPanel from '../components/PlatformIntegrationsPanel.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getAiStatus } from '../services/aiSettingsService.js';
import { ADMIN_PATHS, AUTH_PATHS } from '../routes.js';

// /admin/integrations: the keys of the connected services. Anyone but the platform owner is sent away.
export default function AdminIntegrationsPage() {
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
      <PageHeader
        eyebrow="APEXFIT"
        title={t('adminIntTitle')}
        description={t('adminIntDescription')}
        action={<Link className="button button-secondary" to={ADMIN_PATHS.ai}>{t('adminAiTitle')}</Link>}
      />
      <PlatformIntegrationsPanel />
    </>
  );
}
