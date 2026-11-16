import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMyOnboardingStatus } from '../services/assessmentService.js';
import { onboardingNotices } from '../services/assessmentUtils.js';

const REFRESH_EVENT = 'apexfit:onboarding-changed';

// Pages call this after the client finishes an onboarding task so the reminders update at once.
export function refreshOnboardingNotices() {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

// Reminders for clients: health assessment, required contracts, and the doctor's-clearance alert.
export default function OnboardingNotice() {
  const { t } = useLocale();
  const { profile, user } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const isClient = profile?.role === 'client';

  useEffect(() => {
    const onRefresh = () => setRefreshKey((key) => key + 1);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);

  useEffect(() => {
    if (!isClient) return undefined;
    let active = true;
    getMyOnboardingStatus()
      .then((result) => {
        if (active) setStatus(result);
      })
      .catch(() => {
        if (active) setStatus(null);
      });
    return () => { active = false; };
    // The status is re-read on every page change so notices disappear once a task is done.
  }, [isClient, user?.id, location.pathname, refreshKey]);

  const notices = isClient ? onboardingNotices(status, location.pathname) : [];
  if (notices.length === 0) return null;

  return (
    <div className="onboarding-notices">
      {notices.map((notice) => (
        <div className={`notice ${notice.kind === 'warning' ? 'notice-warning' : 'notice-info'} onboarding-notice`} key={notice.id} role={notice.kind === 'warning' ? 'alert' : 'status'}>
          <span>{notice.count ? `${t(notice.textKey)} ${notice.count}` : t(notice.textKey)}</span>
          <Link className="text-action" to={notice.to}>{t('onbOpen')}</Link>
        </div>
      ))}
    </div>
  );
}
