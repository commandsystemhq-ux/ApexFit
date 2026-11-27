import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RatingStars from '../components/RatingStars.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  adminListCoachReviews, adminListCoaches, adminListReports, adminResolveReport, adminSetCoachHidden, adminSetReviewHidden, isPlatformAdmin,
} from '../services/marketplaceService.js';
import { MODERATION_REASON_MAX, REPORT_REASON_KEYS, countryName, validateModerationReason } from '../services/marketplaceUtils.js';
import { fillTemplate } from '../services/textTemplate.js';
import { AUTH_PATHS } from '../routes.js';

const REPORT_FILTERS = [['open', 'mkAdminStatusOpen'], ['resolved', 'mkAdminStatusResolved'], ['dismissed', 'mkAdminStatusDismissed'], ['all', 'mkAdminStatusAll']];
const COACH_FILTERS = [['all', 'mkAdminStateAll'], ['listed', 'mkAdminStateListed'], ['hidden', 'mkAdminStateHidden']];

function ReasonField({ value, onChange }) {
  const { t } = useLocale();
  return (
    <label className="form-label">{t('mkAdminReasonLabel')}
      <textarea className="field" rows={2} maxLength={MODERATION_REASON_MAX} value={value} placeholder={t('mkAdminReasonPlaceholder')} onChange={(event) => onChange(event.target.value)} dir="auto" />
    </label>
  );
}

function ReportCard({ report, onDone, onError }) {
  const { t, locale } = useLocale();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const isReview = report.target_type === 'review';
  const open = report.status === 'open';

  async function run(action, { required }) {
    const check = validateModerationReason(reason, { required });
    if (!check.valid) {
      onError(t(check.error));
      return;
    }
    setBusy(true);
    try {
      await action(check.value);
      await onDone();
    } catch (error) {
      onError(`${t('mkAdminError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const hideTarget = () => run(
    (text) => (isReview ? adminSetReviewHidden(report.review_id, true, text, report.id) : adminSetCoachHidden(report.coach_id, true, text, report.id)),
    { required: true },
  );
  const close = (status) => run((text) => adminResolveReport(report.id, status, text), { required: true });

  return (
    <article className="panel mk-admin-card">
      <div className="mk-admin-head">
        <span className="soft-badge badge-blue">{t(isReview ? 'mkAdminTargetReview' : 'mkAdminTargetCoach')}</span>
        <span className={`soft-badge ${open ? 'badge-amber' : 'badge-muted'}`}>{t(`mkAdminStatus${report.status[0].toUpperCase()}${report.status.slice(1)}`)}</span>
        <small className="muted-copy">{new Date(report.created_at).toLocaleString(locale)}</small>
      </div>
      <h3 dir="auto">{report.coach_name || t('mkSomeone')}</h3>
      <p><strong>{t(REPORT_REASON_KEYS[report.reason])}</strong>{report.details ? ` - ${report.details}` : ''}</p>
      <small className="muted-copy" dir="auto">{fillTemplate(t('mkAdminReportedBy'), { name: report.reporter_name || t('mkSomeone') })}</small>
      {isReview && (
        <blockquote className="mk-quote">
          <RatingStars value={report.review_rating} label={t('mkYourRating')} />
          <p dir="auto">{report.review_comment}</p>
          {report.review_is_hidden && <span className="soft-badge badge-muted">{t('mkAdminTagHidden')}</span>}
        </blockquote>
      )}
      {!isReview && report.coach_is_hidden && <span className="soft-badge badge-muted">{t('mkAdminTagHidden')}</span>}
      {report.resolution_note && <p className="muted-copy" dir="auto">{fillTemplate(t('mkAdminResolution'), { note: report.resolution_note })}</p>}
      {open && (
        <>
          <ReasonField value={reason} onChange={setReason} />
          <div className="mk-actions">
            <Button variant="secondary" size="small" disabled={busy} onClick={() => close('dismissed')}>{t('mkAdminDismiss')}</Button>
            <Button variant="secondary" size="small" disabled={busy} onClick={() => close('resolved')}>{t('mkAdminResolve')}</Button>
            <Button variant="primary" size="small" disabled={busy} onClick={hideTarget}>{t(isReview ? 'mkAdminHideReview' : 'mkAdminHideCoach')}</Button>
          </div>
        </>
      )}
    </article>
  );
}

function CoachRow({ coach, onDone, onError }) {
  const { t, locale } = useLocale();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviews, setReviews] = useState(null);

  async function toggleCoach() {
    const hide = !coach.is_hidden;
    const check = validateModerationReason(reason, { required: hide });
    if (!check.valid) {
      onError(t(check.error));
      return;
    }
    setBusy(true);
    try {
      await adminSetCoachHidden(coach.coach_id, hide, check.value);
      setReason('');
      await onDone();
    } catch (error) {
      onError(`${t('mkAdminError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleReview(review) {
    const hide = !review.is_hidden;
    const check = validateModerationReason(reason, { required: hide });
    if (!check.valid) {
      onError(t(check.error));
      return;
    }
    setBusy(true);
    try {
      await adminSetReviewHidden(review.id, hide, check.value);
      setReviews(await adminListCoachReviews(coach.coach_id));
    } catch (error) {
      onError(`${t('mkAdminError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function showReviews() {
    try {
      setReviews(await adminListCoachReviews(coach.coach_id));
    } catch (error) {
      onError(`${t('mkAdminError')} ${error.message}`);
    }
  }

  return (
    <article className="panel mk-admin-card">
      <div className="mk-admin-head">
        <span className={`soft-badge ${coach.visible ? 'badge-green' : 'badge-muted'}`}>{t(coach.visible ? 'mkAdminTagVisible' : 'mkAdminTagNotVisible')}</span>
        {coach.is_hidden && <span className="soft-badge badge-amber">{t('mkAdminTagHidden')}</span>}
        {coach.open_reports > 0 && <span className="soft-badge badge-amber">{fillTemplate(t('mkAdminOpenReports'), { count: coach.open_reports })}</span>}
      </div>
      <h3 dir="auto">{coach.display_name || t('mkSomeone')}</h3>
      <p className="muted-copy" dir="auto">{coach.headline}</p>
      <small className="muted-copy" dir="auto">{[coach.city, countryName(coach.country_code, locale)].filter(Boolean).join(', ')}</small>
      {coach.rating_count > 0 && <RatingStars value={coach.rating_avg} count={coach.rating_count} label={t('mkFilterRating')} />}
      {coach.is_hidden && coach.hidden_reason && <p className="muted-copy" dir="auto">{fillTemplate(t('mkAdminHiddenReason'), { reason: coach.hidden_reason })}</p>}
      <ReasonField value={reason} onChange={setReason} />
      <div className="mk-actions">
        <Button variant="secondary" size="small" onClick={showReviews}>{t('mkAdminShowReviews')}</Button>
        <Button variant="primary" size="small" disabled={busy} onClick={toggleCoach}>{t(coach.is_hidden ? 'mkAdminUnhideCoach' : 'mkAdminHideCoach')}</Button>
      </div>
      {reviews && (
        <div className="mk-admin-reviews">
          {reviews.length === 0 && <p className="muted-copy">{t('mkNoReviews')}</p>}
          {reviews.map((review) => (
            <div className="mk-review" key={review.id}>
              <div className="mk-review-head">
                <RatingStars value={review.rating} label={t('mkYourRating')} />
                {review.is_hidden && <span className="soft-badge badge-muted">{t('mkAdminTagHidden')}</span>}
              </div>
              {review.comment && <p dir="auto">{review.comment}</p>}
              {review.is_hidden && review.hidden_reason && <small className="muted-copy" dir="auto">{fillTemplate(t('mkAdminHiddenReason'), { reason: review.hidden_reason })}</small>}
              <Button variant="secondary" size="small" disabled={busy} onClick={() => toggleReview(review)}>{t(review.is_hidden ? 'mkAdminUnhideReview' : 'mkAdminHideReview')}</Button>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

// /admin/marketplace: the platform owner's moderation screen. Who may open it is decided by the database
// (platform_admins); anyone else is sent away as if the page did not exist, and every action is checked there again.
export default function AdminMarketplacePage() {
  const { t } = useLocale();
  const [access, setAccess] = useState('checking');
  const [tab, setTab] = useState('reports');
  const [reportStatus, setReportStatus] = useState('open');
  const [coachState, setCoachState] = useState('all');
  const [query, setQuery] = useState('');
  const [data, setData] = useState({ status: 'loading', reports: null, coaches: null, error: '' });
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let active = true;
    isPlatformAdmin().then((admin) => { if (active) setAccess(admin ? 'admin' : 'denied'); }).catch(() => { if (active) setAccess('denied'); });
    return () => { active = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      if (tab === 'reports') setData({ status: 'ready', reports: await adminListReports(reportStatus), coaches: null, error: '' });
      else setData({ status: 'ready', reports: null, coaches: await adminListCoaches({ query, state: coachState }), error: '' });
    } catch (error) {
      setData({ status: 'error', reports: null, coaches: null, error: error.message });
    }
  }, [tab, reportStatus, coachState, query]);

  useEffect(() => {
    if (access !== 'admin') return undefined;
    const timer = setTimeout(load, tab === 'coaches' ? 250 : 0);
    return () => clearTimeout(timer);
  }, [access, load, tab]);

  if (access === 'denied') return <Navigate to={AUTH_PATHS.home} replace />;
  if (access === 'checking') return <div className="empty-state" role="status">{t('mkLoading')}</div>;

  const done = async () => { setNotice({ kind: 'info', text: t('mkAdminDone') }); await load(); };
  const fail = (text) => setNotice({ kind: 'error', text });

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('adminMkTitle')} description={t('adminMkDescription')} />
      <div className="mk-tabs" role="tablist">
        {[['reports', 'mkAdminReports'], ['coaches', 'mkAdminCoaches']].map(([id, key]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`choice-chip ${tab === id ? 'is-selected' : ''}`} onClick={() => { setTab(id); setNotice(null); }}>
            {t(key)}{id === 'reports' && data.reports ? ` (${data.reports.open_count})` : ''}
          </button>
        ))}
      </div>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {tab === 'reports' && (
        <div className="mk-tabs">
          {REPORT_FILTERS.map(([id, key]) => (
            <button key={id} type="button" className={`choice-chip ${reportStatus === id ? 'is-selected' : ''}`} aria-pressed={reportStatus === id} onClick={() => setReportStatus(id)}>{t(key)}</button>
          ))}
        </div>
      )}
      {tab === 'coaches' && (
        <div className="mk-admin-filters">
          <input className="field" type="search" value={query} placeholder={t('mkAdminSearch')} aria-label={t('mkAdminSearch')} onChange={(event) => setQuery(event.target.value)} dir="auto" />
          <select className="field" value={coachState} onChange={(event) => setCoachState(event.target.value)} aria-label={t('mkAdminCoaches')}>
            {COACH_FILTERS.map(([id, key]) => <option key={id} value={id}>{t(key)}</option>)}
          </select>
        </div>
      )}

      {data.status === 'error' && <div className="notice notice-error" role="alert">{t('mkAdminLoadError')} {data.error}</div>}
      {data.status === 'loading' && <div className="empty-state" role="status">{t('mkLoading')}</div>}
      {tab === 'reports' && data.reports && (
        <div className="mk-admin-list">
          {data.reports.items.length === 0 && <div className="empty-state">{t('mkAdminNoReports')}</div>}
          {data.reports.items.map((report) => <ReportCard key={report.id} report={report} onDone={done} onError={fail} />)}
        </div>
      )}
      {tab === 'coaches' && data.coaches && (
        <div className="mk-admin-list">
          {data.coaches.items.length === 0 && <div className="empty-state">{t('mkAdminNoCoaches')}</div>}
          {data.coaches.items.map((coach) => <CoachRow key={coach.coach_id} coach={coach} onDone={done} onError={fail} />)}
        </div>
      )}
    </>
  );
}
