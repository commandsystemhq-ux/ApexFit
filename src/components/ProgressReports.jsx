import { useCallback, useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  deleteProgressReport, getProgressStats, listProgressReports, saveProgressReport, shareProgressReport,
} from '../services/accountabilityService.js';
import { REPORT_PERIODS, buildReportText, fillText, reportShareText, whatsappUrl, xUrl } from '../services/accountabilityUtils.js';
import { askJack } from '../services/jackUtils.js';

// Smart Progress Reports. Jack writes them from the real numbers, or a ready template does when the AI is not needed.
// A coach writes for one client (clientId); a client writes their own (clientId is null).
export default function ProgressReports({ clientId = null, clientName = '', onNotify }) {
  const { t, locale } = useLocale();
  const { user } = useAuth();
  const coachView = Boolean(clientId);
  const [days, setDays] = useState(30);
  const [reports, setReports] = useState([]);
  const [state, setState] = useState({ loading: true, busy: false, error: '' });

  const load = useCallback(async () => {
    try {
      setReports(await listProgressReports(clientId));
      setState((current) => ({ ...current, loading: false, error: '' }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [clientId]);

  useEffect(() => {
    setState({ loading: true, busy: false, error: '' });
    load();
  }, [load]);

  function ask() {
    const text = coachView
      ? fillText(t('rptAskCoach'), { name: clientName, days })
      : fillText(t('rptAskClient'), { days });
    askJack(text);
  }

  async function quickReport() {
    setState((current) => ({ ...current, busy: true, error: '' }));
    try {
      const stats = await getProgressStats(clientId, days);
      await saveProgressReport(clientId, days, buildReportText(stats, t));
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setState((current) => ({ ...current, busy: false }));
    }
  }

  const textFor = (report) => reportShareText(report.body, window.location.origin);

  async function copy(report) {
    try {
      await navigator.clipboard.writeText(textFor(report));
      onNotify?.(t('rptCopied'));
    } catch {
      onNotify?.(t('rptCopyFailed'));
    }
  }

  async function share(report) {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'ApexFit', text: textFor(report) });
      } catch {
        // Closing the share sheet is not an error.
      }
      return;
    }
    await copy(report);
  }

  async function toggleShared(report) {
    try {
      await shareProgressReport(report.id, !report.shared);
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  async function remove(report) {
    if (!window.confirm(t('rptDeleteConfirm'))) return;
    try {
      await deleteProgressReport(report.id);
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  return (
    <section className="panel rpt-panel" aria-label={t('rptTitle')}>
      <div className="panel-heading">
        <div><span className="eyebrow">{t('rptEyebrow')}</span><h3>{t('rptTitle')}</h3></div>
      </div>
      <p className="muted-copy">{t(coachView ? 'rptHelpCoach' : 'rptHelpClient')}</p>
      <div className="rpt-controls">
        <label className="form-label">{t('rptPeriod')}
          <select className="field" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {REPORT_PERIODS.map((period) => <option key={period} value={period}>{fillText(t('rptPeriodDays'), { n: period })}</option>)}
          </select>
        </label>
        <Button variant="primary" type="button" onClick={ask}>{'\u2726'} {t('rptAskJack')}</Button>
        <Button variant="secondary" type="button" onClick={quickReport} disabled={state.busy}>{state.busy ? t('rptWorking') : t('rptQuick')}</Button>
      </div>
      <p className="rpt-privacy">{t('rptPrivacy')}</p>
      {state.error && <div className="notice notice-error" role="alert">{state.error}</div>}
      {state.loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!state.loading && reports.length === 0 && <div className="empty-state">{t(coachView ? 'rptEmptyCoach' : 'rptEmptyClient')}</div>}
      <div className="rpt-list">
        {reports.map((report) => (
          <article className="rpt-card" key={report.id}>
            <header>
              <strong>{new Date(report.created_at).toLocaleDateString(locale)}</strong>
              <span className="soft-badge badge-muted">{fillText(t('rptPeriodDays'), { n: report.period_days })}</span>
              {coachView && <span className={`soft-badge ${report.shared ? 'badge-green' : 'badge-amber'}`}>{t(report.shared ? 'rptSharedBadge' : 'rptPrivateBadge')}</span>}
            </header>
            <p className="rpt-body" dir="auto">{report.body}</p>
            <div className="rpt-actions">
              <button className="text-action" type="button" onClick={() => copy(report)}>{t('rptCopy')}</button>
              <button className="text-action" type="button" onClick={() => share(report)}>{t('rptShare')}</button>
              <a className="text-action" href={whatsappUrl(textFor(report))} target="_blank" rel="noopener noreferrer">WhatsApp</a>
              <a className="text-action" href={xUrl(textFor(report))} target="_blank" rel="noopener noreferrer">X</a>
              {coachView && <button className="text-action" type="button" onClick={() => toggleShared(report)}>{t(report.shared ? 'rptHide' : 'rptShareWithClient')}</button>}
              {(coachView || report.created_by === user?.id) && <button className="text-action rpt-delete" type="button" onClick={() => remove(report)}>{t('rptDelete')}</button>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}