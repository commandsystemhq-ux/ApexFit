import { useState } from 'react';
import Button from './Button.jsx';
import { CHECKINS_CHANGED_EVENT } from '../hooks/useCheckinBadge.js';
import { useSignedPhotos } from '../hooks/useSignedPhotos.js';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { reviewCheckin } from '../services/checkinService.js';
import { MAX_FEEDBACK, PHOTO_SLOTS, diffCheckins } from '../services/checkinUtils.js';
import { fillText } from '../services/accountabilityUtils.js';
import { notifyClients } from '../services/pushService.js';

const ARROWS = { up: '\u25B2', down: '\u25BC', same: '=' };

// One weekly check-in as the coach sees it: the numbers with the change since the week before, the notes, the photos
// (short-lived private links) and the feedback box. `onReviewed` receives the updated check-in.
export default function CheckinReviewCard({ checkin, showClient = true, onReviewed }) {
  const { t, locale } = useLocale();
  const paths = PHOTO_SLOTS.map((slot) => checkin.photo_paths?.[slot]).filter(Boolean);
  const photos = useSignedPhotos(paths);
  const [feedback, setFeedback] = useState(checkin.coach_feedback || '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const reviewed = checkin.status === 'reviewed';
  const rows = diffCheckins(checkin, checkin.previous);
  const weekLabel = new Date(`${checkin.week_start_date}T12:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });

  async function send(event) {
    event.preventDefault();
    const text = feedback.trim();
    if (!text || text.length > MAX_FEEDBACK) {
      setNotice({ kind: 'error', text: t('ckErr_feedback') });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const updated = await reviewCheckin(checkin.id, text);
      await notifyClients('checkin', checkin.id);
      setNotice({ kind: 'info', text: t('ckFeedbackSent') });
      window.dispatchEvent(new Event(CHECKINS_CHANGED_EVENT));
      onReviewed?.({ ...checkin, ...updated, previous: checkin.previous, client_name: checkin.client_name });
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('ckFeedbackError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="checkin-card">
      <header className="checkin-card-head">
        <div>
          {showClient && <strong dir="auto">{checkin.client_name}</strong>}
          <small>{fillText(t('ckWeekOf'), { date: weekLabel })}</small>
        </div>
        <span className={`soft-badge ${reviewed ? 'badge-green' : 'badge-amber'}`}>{t(reviewed ? 'ckReviewStatusReviewed' : 'ckReviewStatusSubmitted')}</span>
      </header>

      <table className="checkin-diff">
        <caption className="visually-hidden">{t('ckChange')}</caption>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{t(row.labelKey)}</th>
              <td dir="ltr">{row.value === null ? '\u2014' : `${row.value.toLocaleString(locale)}${row.unit === 'kg' || row.unit === 'h' ? ` ${row.unit}` : row.unit}`}</td>
              <td dir="ltr" className={`checkin-delta checkin-delta-${row.direction || 'none'}`}>
                {row.direction ? `${ARROWS[row.direction]} ${row.delta > 0 ? '+' : ''}${row.delta.toLocaleString(locale)}` : '\u2014'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!checkin.previous && <p className="muted-copy">{t('ckFirstWeek')}</p>}

      <div className="checkin-notes">
        <span className="eyebrow">{t('ckClientNotes')}</span>
        <p dir="auto">{checkin.client_notes || t('ckNoNotes')}</p>
      </div>

      {paths.length > 0 && (
        <div className="checkin-photo-row">
          {PHOTO_SLOTS.filter((slot) => checkin.photo_paths?.[slot]).map((slot) => {
            const url = photos.urls[checkin.photo_paths[slot]];
            return (
              <figure key={slot} className="checkin-photo">
                {url
                  ? <a href={url} target="_blank" rel="noopener noreferrer" title={t('ckOpenPhoto')}><img src={url} alt={fillText(t('ckPhotoAlt'), { slot: t(`ckSlot_${slot}`), week: weekLabel })} loading="lazy" /></a>
                  : <div className="checkin-photo-placeholder">{photos.error ? '\u26A0' : t('ckPhotoLoading')}</div>}
                <figcaption>{t(`ckSlot_${slot}`)}</figcaption>
              </figure>
            );
          })}
        </div>
      )}

      <form className="checkin-feedback" onSubmit={send}>
        <label className="form-label">{t('ckFeedbackLabel')}
          <textarea className="field" rows={3} maxLength={MAX_FEEDBACK} value={feedback} placeholder={t('ckFeedbackPlaceholder')} onChange={(event) => setFeedback(event.target.value)} dir="auto" />
        </label>
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        <Button variant={reviewed ? 'secondary' : 'primary'} size="small" type="submit" disabled={busy}>
          {busy ? t('ckSendingFeedback') : t(reviewed ? 'ckUpdateFeedback' : 'ckSendFeedback')}
        </Button>
      </form>
    </article>
  );
}