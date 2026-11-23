import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RatingInput from '../components/RatingInput.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { CHECKINS_CHANGED_EVENT } from '../hooks/useCheckinBadge.js';
import { useSignedPhotos } from '../hooks/useSignedPhotos.js';
import { fillText } from '../services/accountabilityUtils.js';
import { deleteCheckinPhotos, getMyCheckinStatus, listMyCheckins, submitCheckin, uploadCheckinPhoto } from '../services/checkinService.js';
import {
  CHECKIN_PHOTO_TYPES, MAX_CHECKIN_NOTES, PHOTO_SLOTS, emptyCheckinForm, formFromCheckin, validateCheckinForm, validateCheckinPhoto, weekStartOf,
} from '../services/checkinUtils.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';

const emptyPhotos = () => Object.fromEntries(PHOTO_SLOTS.map((slot) => [slot, { file: null, preview: '', removed: false }]));

// The client's weekly check-in: this week's form (editable until the coach reviews it), optional photos, the coach's
// answer, and the weeks sent before.
export default function WeeklyCheckinPage() {
  const { t, locale } = useLocale();
  const today = getLocalDateString();
  const weekStart = weekStartOf(today);
  const [state, setState] = useState({ status: 'loading', checkins: [], coached: true, error: '' });
  const [form, setForm] = useState(emptyCheckinForm());
  const [photos, setPhotos] = useState(emptyPhotos());
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const previews = useRef([]);

  const current = state.checkins.find((checkin) => checkin.week_start_date === weekStart) || null;
  const reviewed = current?.status === 'reviewed';
  const storedPaths = useMemo(() => state.checkins.flatMap((checkin) => PHOTO_SLOTS.map((slot) => checkin.photo_paths?.[slot])).filter(Boolean), [state.checkins]);
  const signed = useSignedPhotos(storedPaths);

  const load = useCallback(async () => {
    try {
      const [checkins, status] = await Promise.all([listMyCheckins(), getMyCheckinStatus(today)]);
      setState({ status: 'ready', checkins, coached: Boolean(status?.has_coach), error: '' });
      const mine = checkins.find((checkin) => checkin.week_start_date === weekStart);
      setForm(mine ? formFromCheckin(mine) : emptyCheckinForm());
    } catch (error) {
      setState({ status: 'error', checkins: [], coached: true, error: error.message });
    }
  }, [today, weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const update = (patch) => {
    setNotice(null);
    setForm((currentForm) => ({ ...currentForm, ...patch }));
  };

  function choosePhoto(slot, file) {
    if (!file) return;
    const problem = validateCheckinPhoto(file);
    if (problem) {
      setErrors((currentErrors) => ({ ...currentErrors, [`photo_${slot}`]: problem }));
      return;
    }
    const preview = URL.createObjectURL(file);
    previews.current.push(preview);
    setErrors((currentErrors) => ({ ...currentErrors, [`photo_${slot}`]: '' }));
    setPhotos((currentPhotos) => ({ ...currentPhotos, [slot]: { file, preview, removed: false } }));
  }

  const removePhoto = (slot) => setPhotos((currentPhotos) => ({ ...currentPhotos, [slot]: { file: null, preview: '', removed: true } }));

  async function submit(event) {
    event.preventDefault();
    const result = validateCheckinForm(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy(true);
    setNotice(null);
    const uploaded = [];
    try {
      const paths = {};
      const replaced = [];
      for (const slot of PHOTO_SLOTS) {
        const stored = current?.photo_paths?.[slot] || null;
        const choice = photos[slot];
        if (choice.file) {
          const path = await uploadCheckinPhoto(weekStart, slot, choice.file);
          uploaded.push(path);
          paths[slot] = path;
          if (stored) replaced.push(stored);
        } else if (choice.removed) {
          if (stored) replaced.push(stored);
        } else if (stored) {
          paths[slot] = stored;
        }
      }
      await submitCheckin(weekStart, result.payload, paths);
      await deleteCheckinPhotos(replaced).catch(() => {});
      setPhotos(emptyPhotos());
      setNotice({ kind: 'info', text: t('ckSent') });
      window.dispatchEvent(new Event(CHECKINS_CHANGED_EVENT));
      await load();
    } catch (error) {
      await deleteCheckinPhotos(uploaded).catch(() => {});
      setNotice({ kind: 'error', text: `${t('ckSendError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  const formatWeek = (date) => new Date(`${date}T12:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const fieldError = (key) => errors[key] && <small className="field-error">{t(errors[key])}</small>;

  const photoSource = (slot) => {
    const choice = photos[slot];
    if (choice.preview) return choice.preview;
    if (choice.removed) return '';
    return signed.urls[current?.photo_paths?.[slot]] || '';
  };
  const hasPhoto = (slot) => Boolean(photos[slot].file) || (!photos[slot].removed && Boolean(current?.photo_paths?.[slot]));

  const history = state.checkins.filter((checkin) => checkin.week_start_date !== weekStart);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('ckTitle')} description={t('ckDescription')} />
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('ckLoadError')} {state.error}</div>}
      {state.status === 'ready' && (
        <>
          {!current && state.coached && <div className="notice notice-warning" role="status">{t('ckDueNotice')}</div>}
          {!state.coached && <div className="notice notice-info" role="status">{t('ckNoCoach')}</div>}
          {current && !reviewed && <div className="notice notice-info" role="status">{t('ckSentNotice')}</div>}

          <section className="panel checkin-form-panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('ckTitle')}</span><h3>{fillText(t('ckWeekOf'), { date: formatWeek(weekStart) })}</h3></div></div>

            {reviewed ? (
              <div className="checkin-reviewed">
                <span className="soft-badge badge-green">{t('ckReviewStatusReviewed')}</span>
                <span className="eyebrow">{t('ckCoachFeedback')}</span>
                <p dir="auto">{current.coach_feedback}</p>
              </div>
            ) : (
              <form className="checkin-form" onSubmit={submit} noValidate>
                <div className="checkin-form-grid">
                  <label className="form-label">{t('ckWeight')}
                    <input className="field" type="number" inputMode="decimal" min="20" max="500" step="0.1" value={form.weight} onChange={(event) => update({ weight: event.target.value })} aria-invalid={Boolean(errors.weight)} />
                    {fieldError('weight')}
                  </label>
                  <label className="form-label">{t('ckSleepHours')}
                    <input className="field" type="number" inputMode="decimal" min="0" max="24" step="0.25" value={form.sleepHours} onChange={(event) => update({ sleepHours: event.target.value })} aria-invalid={Boolean(errors.sleepHours)} />
                    {fieldError('sleepHours')}
                  </label>
                </div>
                {[['sleepQuality', 'ckSleepQuality', 5], ['workout', 'ckWorkout', 10], ['diet', 'ckDiet', 10], ['energy', 'ckEnergy', 5]].map(([key, label, max]) => (
                  <div className="form-label" key={key}>
                    <span>{t(label)}</span>
                    <RatingInput label={t(label)} value={form[key]} max={max} invalid={Boolean(errors[key])} onChange={(value) => update({ [key]: value })} />
                    {fieldError(key)}
                  </div>
                ))}
                <label className="form-label">{t('ckNotes')}
                  <textarea className="field" rows={4} maxLength={MAX_CHECKIN_NOTES} value={form.notes} placeholder={t('ckNotesPlaceholder')} onChange={(event) => update({ notes: event.target.value })} dir="auto" />
                  {fieldError('notes')}
                </label>

                <fieldset className="checkin-photos">
                  <legend>{t('ckPhotos')}</legend>
                  <p className="muted-copy">{t('ckPhotosHelp')}</p>
                  <div className="checkin-photo-pickers">
                    {PHOTO_SLOTS.map((slot) => (
                      <div className="checkin-photo-picker" key={slot}>
                        <strong>{t(`ckSlot_${slot}`)}</strong>
                        {photoSource(slot)
                          ? <img src={photoSource(slot)} alt={t(`ckSlot_${slot}`)} />
                          : <div className="checkin-photo-placeholder">{hasPhoto(slot) ? t('ckPhotoLoading') : '\u2014'}</div>}
                        <label className="button button-secondary button-small">
                          {hasPhoto(slot) ? t('ckChangePhoto') : t('ckChoosePhoto')}
                          <input className="visually-hidden" type="file" accept={Object.keys(CHECKIN_PHOTO_TYPES).join(',')} onChange={(event) => { choosePhoto(slot, event.target.files?.[0]); event.target.value = ''; }} />
                        </label>
                        {hasPhoto(slot) && <button type="button" className="text-action" onClick={() => removePhoto(slot)}>{t('ckRemovePhoto')}</button>}
                        {fieldError(`photo_${slot}`)}
                      </div>
                    ))}
                  </div>
                </fieldset>

                {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
                <Button variant="primary" type="submit" disabled={busy}>{busy ? t('ckSending') : t(current ? 'ckUpdate' : 'ckSubmit')}</Button>
              </form>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('ckTitle')}</span><h3>{t('ckHistory')}</h3></div></div>
            {history.length === 0 && <div className="empty-state">{t('ckNoHistory')}</div>}
            <div className="checkin-history">
              {history.map((checkin) => (
                <article className="checkin-history-row" key={checkin.id}>
                  <header>
                    <strong>{fillText(t('ckWeekOf'), { date: formatWeek(checkin.week_start_date) })}</strong>
                    <span className={`soft-badge ${checkin.status === 'reviewed' ? 'badge-green' : 'badge-amber'}`}>{t(checkin.status === 'reviewed' ? 'ckReviewStatusReviewed' : 'ckReviewStatusSubmitted')}</span>
                  </header>
                  <p className="muted-copy" dir="ltr">
                    {checkin.weight_kg !== null && `${Number(checkin.weight_kg).toLocaleString(locale)} kg · `}
                    {t('ckWorkout')}: {checkin.workout_adherence_1_10}/10 · {t('ckDiet')}: {checkin.diet_adherence_1_10}/10 · {t('ckEnergy')}: {checkin.energy_level_1_5}/5
                  </p>
                  {checkin.coach_feedback
                    ? <p className="checkin-feedback-text" dir="auto"><strong>{t('ckCoachFeedback')}:</strong> {checkin.coach_feedback}</p>
                    : <p className="muted-copy">{t('ckAwaitingReview')}</p>}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}