import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import MarketplaceReport from '../components/MarketplaceReport.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RatingStars from '../components/RatingStars.jsx';
import UserAvatar from '../components/UserAvatar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  getMyMarketplaceProfile, listCoachContactRequests, listCoachReviews, pushMarketplaceEvent, replyToReview, respondToContactRequest, saveMyMarketplaceProfile,
} from '../services/marketplaceService.js';
import {
  BIO_MAX, CITY_MAX, HEADLINE_MAX, MARKETPLACE_LANGUAGES, REPLY_MAX, REQUEST_STATUS_KEYS, TRAINING_MODES, TRAINING_MODE_KEYS, coachPath, countryOptions, languageName,
  profileToForm, validateProfileForm, validateReply, visibilityProblems,
} from '../services/marketplaceUtils.js';
import { announceNotificationsChanged } from '../services/notificationService.js';
import { fillTemplate } from '../services/textTemplate.js';
import { PAGES } from '../routes.js';

function ReplyBox({ review, onSent }) {
  const { t } = useLocale();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send(event) {
    event.preventDefault();
    const result = validateReply(text);
    if (!result.valid) {
      setError(t(result.error));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await replyToReview(review.id, result.value);
      await onSent();
    } catch (sendError) {
      setError(`${t('mkReplyError')} ${sendError.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mk-reply-form" onSubmit={send} noValidate>
      <textarea className="field" rows={2} maxLength={REPLY_MAX} value={text} placeholder={t('mkReplyPlaceholder')} aria-label={t('mkReply')} onChange={(event) => setText(event.target.value)} dir="auto" />
      <small className="muted-copy">{t('mkReplyHelp')}</small>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <Button variant="secondary" size="small" type="submit" disabled={busy}>{t('mkSendReply')}</Button>
    </form>
  );
}

function Requests({ requests, busyId, onAnswer }) {
  const { t, locale } = useLocale();
  return (
    <section className="panel mk-requests">
      <div className="panel-heading"><div><span className="eyebrow">{t('navMarketplace')}</span><h3>{t('mkRequestsTitle')}</h3></div></div>
      <p className="muted-copy">{t('mkRequestsHelp')}</p>
      {requests.length === 0 && <div className="empty-state">{t('mkRequestsEmpty')}</div>}
      {requests.map((item) => (
        <article className="mk-request-row" key={item.id}>
          <div>
            <strong dir="auto">{fillTemplate(t('mkFromClient'), { name: item.client_name || t('mkAnonymousClient') })}</strong>
            <p dir="auto">{item.message}</p>
            <small className="muted-copy">{new Date(item.created_at).toLocaleString(locale)}</small>
          </div>
          {item.status === 'pending' ? (
            <div className="mk-actions">
              <Button variant="secondary" size="small" disabled={busyId === item.id} onClick={() => onAnswer(item, false)}>{t('mkDecline')}</Button>
              <Button variant="primary" size="small" disabled={busyId === item.id} onClick={() => onAnswer(item, true)}>{t('mkAccept')}</Button>
            </div>
          ) : (
            <div className="mk-actions">
              <span className={`soft-badge ${item.status === 'accepted' ? 'badge-green' : 'badge-muted'}`}>{t(REQUEST_STATUS_KEYS[item.status])}</span>
              {item.status === 'accepted' && item.client_id && <Link className="text-action" to={`/messages?with=${item.client_id}`}>{t('mkOpenChat')}</Link>}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

// The coach's side of the marketplace: the public profile, the contact requests clients sent and the reviews about them.
export default function MarketplaceProfilePage() {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', profile: null, requests: [], reviews: { items: [], total: 0 }, error: '' });
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState('');
  const countries = useMemo(() => countryOptions(locale), [locale]);

  const load = useCallback(async () => {
    try {
      const profile = await getMyMarketplaceProfile();
      const [requests, reviews] = await Promise.all([listCoachContactRequests(), listCoachReviews(profile.coach_id, { limit: 50 })]);
      setState({ status: 'ready', profile, requests: requests.items || [], reviews, error: '' });
      setForm((current) => current || profileToForm(profile));
    } catch (error) {
      setState((current) => ({ ...current, status: 'error', error: error.message }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const toggleLanguage = (code) => update({ languages: form.languages.includes(code) ? form.languages.filter((item) => item !== code) : [...form.languages, code] });
  const say = (kind, text) => setNotice({ kind, text });

  async function save(event) {
    event.preventDefault();
    const result = validateProfileForm(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await saveMyMarketplaceProfile(result.payload);
      setForm(profileToForm(saved));
      say('info', t('mkSaved'));
      await load();
    } catch (error) {
      say('error', `${t('mkSaveError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function answer(item, accept) {
    setBusyId(item.id);
    setNotice(null);
    try {
      const result = await respondToContactRequest(item.id, accept);
      announceNotificationsChanged();
      if (accept) {
        pushMarketplaceEvent('marketplace_accepted', item.id);
        const parts = [fillTemplate(t('mkAcceptedNotice'), { name: item.client_name || t('mkAnonymousClient') })];
        if (result.already_linked) parts.push(t('mkAlreadyLinked'));
        if (result.other_active_coaches > 0) parts.push(fillTemplate(t('mkOtherCoaches'), { count: result.other_active_coaches }));
        say('info', parts.join(' '));
        await load();
        navigate(result.chat_path);
        return;
      }
      say('info', t('mkDeclinedNotice'));
      await load();
    } catch (error) {
      say('error', `${t('mkRespondError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  const fieldError = (key) => errors[key] && <small className="field-error" role="alert">{t(errors[key])}</small>;
  if (state.status === 'loading') return <div className="empty-state" role="status">{t('mkLoading')}</div>;
  if (state.status === 'error' && !state.profile) return <div className="notice notice-error" role="alert">{t('mkProfileLoadError')} {state.error}</div>;

  const { profile } = state;
  const problems = visibilityProblems(profile);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('mkProfileTitle')} description={t('mkProfileDescription')}
        action={profile.visible ? <Link className="button button-secondary" to={coachPath(profile.coach_id)}>{t('mkViewProfile')}</Link> : null} />
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      <section className={`panel mk-status ${profile.visible ? 'is-visible' : 'is-hidden'}`}>
        <div className="mk-status-head">
          <span className={`soft-badge ${profile.visible ? 'badge-green' : 'badge-amber'}`}>{profile.visible ? t('mkAdminTagVisible') : t('mkAdminTagNotVisible')}</span>
          {profile.rating_count > 0 && <RatingStars value={profile.rating_avg} count={profile.rating_count} label={t('mkFilterRating')} />}
        </div>
        {profile.visible && <p>{t('mkStatusVisible')}</p>}
        {!profile.visible && (
          <>
            <p>{t('mkStatusHidden')}</p>
            <ul>{problems.map((key) => <li key={key}>{t(key)}</li>)}</ul>
            {profile.is_hidden && profile.hidden_reason && <p className="muted-copy" dir="auto">{t('mkModerationReason')} {profile.hidden_reason}</p>}
          </>
        )}
      </section>

      {form && (
        <form className="panel mk-form" onSubmit={save} noValidate>
          <div className="mk-form-photo">
            <UserAvatar profile={{ avatar_path: profile.avatar_path, full_name: profile.display_name }} size="large" />
            <div>
              <strong dir="auto">{profile.display_name}</strong>
              <p className="muted-copy">{t('mkPhotoHelp')}</p>
              <Link className="text-action" to={PAGES.settings.path}>{t('mkSettingsLink')}</Link>
            </div>
          </div>

          <label className="checkbox-row"><input type="checkbox" checked={form.isListed} onChange={(event) => update({ isListed: event.target.checked })} />{t('mkListMe')}</label>
          <small className="muted-copy">{t('mkListMeHelp')}</small>
          <label className="checkbox-row"><input type="checkbox" checked={form.acceptingClients} onChange={(event) => update({ acceptingClients: event.target.checked })} />{t('mkAccepting')}</label>

          <label className="form-label">{t('mkHeadline')}
            <input className="field" value={form.headline} maxLength={HEADLINE_MAX} placeholder={t('mkHeadlinePlaceholder')} onChange={(event) => update({ headline: event.target.value })} aria-invalid={Boolean(errors.headline)} dir="auto" />
            {fieldError('headline')}
          </label>
          <label className="form-label">{t('mkBio')}
            <textarea className="field" rows={6} value={form.bio} maxLength={BIO_MAX} placeholder={t('mkBioPlaceholder')} onChange={(event) => update({ bio: event.target.value })} aria-invalid={Boolean(errors.bio)} dir="auto" />
            {fieldError('bio')}
          </label>
          <div className="mk-form-grid">
            <label className="form-label">{t('mkSpecialties')}
              <input className="field" value={form.specialties} onChange={(event) => update({ specialties: event.target.value })} aria-invalid={Boolean(errors.specialties)} dir="auto" />
              <small className="muted-copy">{t('mkSpecialtiesHelp')}</small>
              {fieldError('specialties')}
            </label>
            <label className="form-label">{t('mkCertifications')}
              <input className="field" value={form.certifications} onChange={(event) => update({ certifications: event.target.value })} aria-invalid={Boolean(errors.certifications)} dir="auto" />
              <small className="muted-copy">{t('mkCertificationsHelp')}</small>
              {fieldError('certifications')}
            </label>
          </div>
          <fieldset className="mk-languages">
            <legend>{t('mkLanguages')}</legend>
            <div className="mk-chips">
              {MARKETPLACE_LANGUAGES.map((code) => (
                <button key={code} type="button" className={`choice-chip ${form.languages.includes(code) ? 'is-selected' : ''}`} aria-pressed={form.languages.includes(code)} onClick={() => toggleLanguage(code)}>
                  {languageName(code, locale)}
                </button>
              ))}
            </div>
            {fieldError('languages')}
          </fieldset>
          <div className="mk-form-grid">
            <label className="form-label">{t('mkYears')}
              <input className="field" type="number" min="0" max="60" inputMode="numeric" value={form.yearsExperience} onChange={(event) => update({ yearsExperience: event.target.value })} aria-invalid={Boolean(errors.yearsExperience)} dir="ltr" />
              {fieldError('yearsExperience')}
            </label>
            <label className="form-label">{t('mkTrainingMode')}
              <select className="field" value={form.trainingMode} onChange={(event) => update({ trainingMode: event.target.value })}>
                {TRAINING_MODES.map((mode) => <option key={mode} value={mode}>{t(TRAINING_MODE_KEYS[mode])}</option>)}
              </select>
              {fieldError('trainingMode')}
            </label>
            <label className="form-label">{t('mkCountry')}
              <select className="field" value={form.countryCode} onChange={(event) => update({ countryCode: event.target.value })} aria-invalid={Boolean(errors.countryCode)}>
                <option value="">{t('mkCountryPick')}</option>
                {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
              </select>
              {fieldError('countryCode')}
            </label>
            <label className="form-label">{t('mkCity')}
              <input className="field" value={form.city} maxLength={CITY_MAX} onChange={(event) => update({ city: event.target.value })} aria-invalid={Boolean(errors.city)} dir="auto" />
              {fieldError('city')}
            </label>
          </div>
          <label className="form-label">{t('mkIntroVideo')}
            <input className="field" type="url" inputMode="url" value={form.introVideoUrl} placeholder="https://" onChange={(event) => update({ introVideoUrl: event.target.value })} aria-invalid={Boolean(errors.introVideoUrl)} dir="ltr" />
            <small className="muted-copy">{t('mkIntroVideoHelp')}</small>
            {fieldError('introVideoUrl')}
          </label>
          <div className="habit-modal-actions">
            <Button variant="primary" type="submit" disabled={busy}>{busy ? t('mkSaving') : t('mkSave')}</Button>
          </div>
        </form>
      )}

      <Requests requests={state.requests} busyId={busyId} onAnswer={answer} />

      <section className="panel mk-reviews">
        <div className="panel-heading"><div><span className="eyebrow">{t('navMarketplace')}</span><h3>{t('mkReviewsAboutYou')}</h3></div></div>
        {state.reviews.items.length === 0 && <div className="empty-state">{t('mkNoReviews')}</div>}
        {state.reviews.items.map((review) => (
          <article className="mk-review" key={review.id}>
            <div className="mk-review-head">
              <RatingStars value={review.rating} label={t('mkYourRating')} />
              <small className="muted-copy">{[review.reviewer_name, new Date(review.created_at).toLocaleDateString(locale)].filter(Boolean).join(' \u00B7 ')}</small>
            </div>
            {review.comment && <p dir="auto">{review.comment}</p>}
            {review.coach_reply
              ? <div className="mk-reply"><strong>{t('mkCoachReply')}</strong><p dir="auto">{review.coach_reply}</p></div>
              : <ReplyBox review={review} onSent={load} />}
            <MarketplaceReport targetType="review" targetId={review.id} reported={review.reported_by_me} />
          </article>
        ))}
      </section>
    </>
  );
}
