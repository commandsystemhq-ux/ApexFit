import { useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { reportMarketplace } from '../services/marketplaceService.js';
import { REPORT_DETAILS_MAX, REPORT_REASONS, REPORT_REASON_KEYS, validateReport } from '../services/marketplaceUtils.js';

// "Report" for a coach profile or one review: pick a reason, optionally add details. The database keeps one report per
// person and target, so a second attempt is answered instead of being stored again.
export default function MarketplaceReport({ targetType, targetId, reported = false, onReported }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  if (reported && !message) return <span className="muted-copy mk-reported">{t('mkReported')}</span>;
  if (message?.kind === 'info') return <span className="muted-copy mk-reported" role="status">{message.text}</span>;

  async function send(event) {
    event.preventDefault();
    const result = validateReport({ reason, details });
    if (!result.valid) {
      setMessage({ kind: 'error', text: t(result.error) });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await reportMarketplace(targetType, targetId, result.reason, result.details);
      setMessage({ kind: 'info', text: t('mkReportSent') });
      setOpen(false);
      onReported?.();
    } catch (error) {
      setMessage({ kind: 'error', text: `${t('mkReportError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <button className="text-action mk-report-link" type="button" onClick={() => setOpen(true)}>{t(targetType === 'coach' ? 'mkReportCoach' : 'mkReportReview')}</button>;

  return (
    <form className="mk-report-form" onSubmit={send} noValidate>
      <label className="form-label">{t('mkReportReason')}
        <select className="field" value={reason} onChange={(event) => setReason(event.target.value)}>
          <option value="">-</option>
          {REPORT_REASONS.map((key) => <option key={key} value={key}>{t(REPORT_REASON_KEYS[key])}</option>)}
        </select>
      </label>
      <label className="form-label">{t('mkReportDetails')}
        <textarea className="field" rows={2} maxLength={REPORT_DETAILS_MAX} value={details} onChange={(event) => setDetails(event.target.value)} dir="auto" />
      </label>
      {message?.kind === 'error' && <div className="notice notice-error" role="alert">{message.text}</div>}
      <div className="mk-actions">
        <Button variant="secondary" size="small" type="button" onClick={() => { setOpen(false); setMessage(null); }}>{t('mkCancel')}</Button>
        <Button variant="primary" size="small" type="submit" disabled={busy}>{t('mkReportSend')}</Button>
      </div>
    </form>
  );
}
