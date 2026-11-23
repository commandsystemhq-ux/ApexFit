import { useCallback, useEffect, useState } from 'react';
import CheckinReviewCard from './CheckinReviewCard.jsx';
import PhotoCompare from './PhotoCompare.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getCheckinsForCoach } from '../services/checkinService.js';

// The "Check-ins" tab of one client for the coach: every week with the change from the week before, the feedback box
// and the side-by-side photo comparison.
export default function ClientCheckinsReview({ clientId }) {
  const { t } = useLocale();
  const [state, setState] = useState({ status: 'loading', checkins: [], error: '' });

  const load = useCallback(() => getCheckinsForCoach({ clientId, limit: 100 })
    .then((checkins) => setState({ status: 'ready', checkins: checkins || [], error: '' }))
    .catch((error) => setState({ status: 'error', checkins: [], error: error.message })), [clientId]);

  useEffect(() => {
    setState({ status: 'loading', checkins: [], error: '' });
    load();
  }, [load]);

  const replace = (updated) => setState((current) => ({ ...current, checkins: current.checkins.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)) }));

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{t('ckLoadError')} {state.error}</div>;
  if (state.checkins.length === 0) return <div className="empty-state">{t('ckNoCheckins')}</div>;

  return (
    <div className="client-checkins">
      <PhotoCompare checkins={state.checkins} />
      {state.checkins.map((checkin) => (
        <CheckinReviewCard key={checkin.id} checkin={checkin} showClient={false} onReviewed={replace} />
      ))}
    </div>
  );
}