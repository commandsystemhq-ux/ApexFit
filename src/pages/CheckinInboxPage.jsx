import { useCallback, useEffect, useState } from 'react';
import CheckinReviewCard from '../components/CheckinReviewCard.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getCheckinsForCoach } from '../services/checkinService.js';

// The coach's weekly review inbox: what clients sent and has not been answered yet, and what was already answered.
export default function CheckinInboxPage() {
  const { t } = useLocale();
  const [tab, setTab] = useState('submitted');
  const [state, setState] = useState({ status: 'loading', checkins: [], error: '' });

  const load = useCallback(() => getCheckinsForCoach({ status: tab, limit: 100 })
    .then((checkins) => setState({ status: 'ready', checkins: checkins || [], error: '' }))
    .catch((error) => setState({ status: 'error', checkins: [], error: error.message })), [tab]);

  useEffect(() => {
    setState({ status: 'loading', checkins: [], error: '' });
    load();
  }, [load]);

  // A check-in that was just answered leaves the waiting list.
  const handleReviewed = (updated) => setState((current) => ({
    ...current,
    checkins: tab === 'submitted' ? current.checkins.filter((item) => item.id !== updated.id) : current.checkins.map((item) => (item.id === updated.id ? updated : item)),
  }));

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('ckInboxTitle')} description={t('ckInboxDescription')} />
      <div className="client-feature-tabs" role="tablist" aria-label={t('ckInboxTitle')}>
        {[['submitted', 'ckTabPending'], ['reviewed', 'ckTabReviewed']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`client-feature-tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>{t(label)}</button>
        ))}
      </div>
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('ckLoadError')} {state.error}</div>}
      {state.status === 'ready' && state.checkins.length === 0 && <div className="empty-state">{t(tab === 'submitted' ? 'ckInboxEmpty' : 'ckInboxEmptyReviewed')}</div>}
      <div className="checkin-list">
        {state.checkins.map((checkin) => <CheckinReviewCard key={checkin.id} checkin={checkin} onReviewed={handleReviewed} />)}
      </div>
    </>
  );
}