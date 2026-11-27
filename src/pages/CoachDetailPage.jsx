import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import MarketplaceReport from '../components/MarketplaceReport.jsx';
import MarketplaceVideo from '../components/MarketplaceVideo.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RatingInput from '../components/RatingInput.jsx';
import RatingStars from '../components/RatingStars.jsx';
import UserAvatar from '../components/UserAvatar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  cancelContactRequest, getMarketplaceCoach, listCoachReviews, pushMarketplaceEvent, sendContactRequest, submitCoachReview,
} from '../services/marketplaceService.js';
import {
  REQUEST_MESSAGE_MAX, REVIEW_COMMENT_MAX, TRAINING_MODE_KEYS, contactState, daysUntilReview, distributionBars, languageName, placeLabel,
  validateRequestMessage, validateReview,
} from '../services/marketplaceUtils.js';
import { announceNotificationsChanged } from '../services/notificationService.js';
import { fillTemplate } from '../services/textTemplate.js';
import { PAGES } from '../routes.js';

const REVIEW_PAGE = 20;

function ContactPanel({ coach, onChanged }) {
  const { t } = useLocale();
  const state = contactState(coach);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  async function send(event) {
    event.preventDefault();
    const result = validateRequestMessage(message);
    if (!result.valid) {
      setNotice({ kind: 'error', text: t(result.error) });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const sent = await sendContactRequest(coach.coach_id, result.value);
      pushMarketplaceEvent('marketplace_request', sent.id);
      setMessage('');
      setNotice({ kind: 'info', text: t('mkRequestSent') });
      await onChanged();
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('mkRequestError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await cancelContactRequest(coach.viewer.pending_request.id);
      announceNotificationsChanged();
      setNotice({ kind: 'info', text: t('mkRequestCancelled') });
      await onChanged();
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('mkRequestError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  const stateText = { linked: 'mkStateLinked', pending: 'mkStatePending', closed: 'mkStateClosed', limit: 'mkStateLimit', not_client: 'mkStateNotClient' }[state];
  return (
    <section className="panel mk-contact">
      <div className="panel-heading"><div><span className="eyebrow">{t('mkContactTitle')}</span><h3>{t('mkContactTitle')}</h3></div></div>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {stateText && <p className="muted-copy">{t(stateText)}</p>}
      {state === 'linked' && <Link className="button button-secondary button-small" to={PAGES.coachHub.path}>{t('mkGoToCoachHub')}</Link>}
      {state === 'pending' && <Button variant="secondary" size="small" disabled={busy} onClick={cancel}>{t('mkCancelRequest')}</Button>}
      {state === 'can_request' && (
        <form onSubmit={send} noValidate className="mk-contact-form">
          <p className="muted-copy">{t('mkContactHelp')}</p>
          <label className="form-label">{t('mkMessageLabel')}
            <textarea className="field" rows={4} maxLength={REQUEST_MESSAGE_MAX} value={message} placeholder={t('mkMessagePlaceholder')} onChange={(event) => setMessage(event.target.value)} dir="auto" />
          </label>
          <small className="muted-copy">{fillTemplate(t('mkRequestsLeft'), { count: coach.viewer.requests_left })}</small>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? t('mkSending') : t('mkSendRequest')}</Button>
        </form>
      )}
    </section>
  );
}

function ReviewForm({ coach, onSaved }) {
  const { t } = useLocale();
  const mine = coach.viewer.my_review;
  const [rating, setRating] = useState(mine?.rating || 0);
  const [comment, setComment] = useState(mine?.comment || '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  async function save(event) {
    event.preventDefault();
    const result = validateReview({ rating, comment });
    if (!result.valid) {
      setNotice({ kind: 'error', text: t(result.errors.rating || result.errors.comment) });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await submitCoachReview(coach.coach_id, result.rating, result.comment);
      setNotice({ kind: 'info', text: t('mkReviewSaved') });
      await onSaved();
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('mkReviewError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mk-review-form" onSubmit={save} noValidate>
      <h4>{t('mkWriteReview')}</h4>
      {mine?.is_hidden && <div className="notice notice-info" role="status">{t('mkReviewHidden')}</div>}
      <div className="form-label">{t('mkYourRating')}<RatingInput label={t('mkYourRating')} value={rating} max={5} onChange={setRating} /></div>
      <label className="form-label">{t('mkYourComment')}
        <textarea className="field" rows={3} maxLength={REVIEW_COMMENT_MAX} value={comment} onChange={(event) => setComment(event.target.value)} dir="auto" />
      </label>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      <Button variant="primary" type="submit" disabled={busy}>{mine ? t('mkUpdateReview') : t('mkSubmitReview')}</Button>
    </form>
  );
}

function Reviews({ coach, reviews, onMore, onChanged }) {
  const { t, locale } = useLocale();
  const viewer = coach.viewer;
  const bars = distributionBars(coach.distribution, coach.rating_count);
  const waitDays = viewer.is_client && !viewer.can_review && viewer.review_eligible_at ? daysUntilReview(viewer.review_eligible_at) : 0;

  return (
    <section className="panel mk-reviews">
      <div className="panel-heading"><div><span className="eyebrow">{t('mkReviewsTitle')}</span><h3>{fillTemplate(t('mkReviewsCount'), { count: coach.rating_count })}</h3></div></div>
      {coach.rating_count > 0 && (
        <div className="mk-distribution">
          <RatingStars value={coach.rating_avg} label={t('mkFilterRating')} />
          <div className="mk-bars">
            {bars.map((bar) => (
              <div className="mk-bar-row" key={bar.stars}>
                <span dir="ltr">{bar.stars}{'\u2605'}</span>
                <span className="mk-bar"><span style={{ width: `${bar.percent}%` }} /></span>
                <small className="muted-copy">{bar.amount}</small>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewer.is_client && viewer.can_review && <ReviewForm coach={coach} onSaved={onChanged} key={viewer.my_review?.updated_at || 'new'} />}
      {viewer.is_client && !viewer.can_review && waitDays > 0 && <p className="muted-copy" role="status">{fillTemplate(t('mkReviewWait'), { days: waitDays })}</p>}
      {viewer.is_client && !viewer.can_review && waitDays === 0 && !viewer.review_eligible_at && <p className="muted-copy">{t('mkReviewNeedsLink')}</p>}

      {reviews.items.length === 0 && <p className="muted-copy">{t('mkNoReviews')}</p>}
      {reviews.items.map((review) => (
        <article className="mk-review" key={review.id}>
          <div className="mk-review-head">
            <RatingStars value={review.rating} label={t('mkYourRating')} />
            <small className="muted-copy">{[review.reviewer_name, t('mkVerifiedClient'), new Date(review.created_at).toLocaleDateString(locale)].filter(Boolean).join(' · ')}</small>
          </div>
          {review.comment && <p dir="auto">{review.comment}</p>}
          {review.coach_reply && (
            <div className="mk-reply">
              <strong>{t('mkCoachReply')}</strong>
              <p dir="auto">{review.coach_reply}</p>
            </div>
          )}
          {!review.is_mine && <MarketplaceReport targetType="review" targetId={review.id} reported={review.reported_by_me} />}
        </article>
      ))}
      {reviews.items.length < reviews.total && <Button variant="secondary" size="small" onClick={onMore}>{t('mkLoadMoreReviews')}</Button>}
    </section>
  );
}

// /coaches/:coachId: the public page of one coach, with reviews, the contact request form and the report button.
export default function CoachDetailPage() {
  const { coachId } = useParams();
  const { t, locale } = useLocale();
  const [state, setState] = useState({ status: 'loading', coach: null, reviews: { items: [], total: 0 }, error: '' });

  const load = useCallback(async (reviewLimit = REVIEW_PAGE) => {
    try {
      const coach = await getMarketplaceCoach(coachId);
      if (!coach) {
        setState({ status: 'missing', coach: null, reviews: { items: [], total: 0 }, error: '' });
        return;
      }
      const reviews = await listCoachReviews(coachId, { limit: reviewLimit, offset: 0 });
      setState({ status: 'ready', coach, reviews, error: '' });
    } catch (error) {
      setState({ status: 'error', coach: null, reviews: { items: [], total: 0 }, error: error.message });
    }
  }, [coachId]);

  useEffect(() => { setState((current) => ({ ...current, status: 'loading' })); load(); }, [load]);

  const back = <Link className="text-action" to={PAGES.coaches.path}>{'\u2190'} {t('mkBack')}</Link>;
  if (state.status === 'loading') return <div className="empty-state" role="status">{t('mkLoading')}</div>;
  if (state.status === 'error') return <><div className="notice notice-error" role="alert">{t('mkLoadError')} {state.error}</div>{back}</>;
  if (state.status === 'missing') return <><div className="empty-state">{t('mkNotFound')}</div>{back}</>;

  const { coach, reviews } = state;
  const place = placeLabel(coach, locale);
  const refresh = () => load(Math.max(REVIEW_PAGE, reviews.items.length));

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={coach.display_name} description={coach.headline} action={back} />
      <div className="mk-detail">
        <div className="mk-detail-main">
          <section className="panel mk-hero">
            <UserAvatar profile={{ avatar_path: coach.avatar_path, full_name: coach.display_name }} size="large" />
            <div className="mk-hero-copy">
              {coach.rating_count > 0 ? <RatingStars value={coach.rating_avg} count={coach.rating_count} label={t('mkFilterRating')} /> : <small className="muted-copy">{t('mkNoReviewsYet')}</small>}
              <div className="mk-chips">
                <span className={`soft-badge ${coach.accepting_clients ? 'badge-green' : 'badge-muted'}`}>{t(coach.accepting_clients ? 'mkAcceptingBadge' : 'mkFullBadge')}</span>
                <span className="soft-badge badge-cyan">{t(TRAINING_MODE_KEYS[coach.training_mode] || 'mkModeOnline')}</span>
              </div>
              <ul className="mk-facts">
                {place && <li dir="auto">{t('mkLocation')}: {place}</li>}
                {coach.years_experience !== null && <li>{t('mkExperience')}: {fillTemplate(t('mkYearsShort'), { count: coach.years_experience })}</li>}
                {coach.languages.length > 0 && <li>{t('mkLanguagesTitle')}: {coach.languages.map((code) => languageName(code, locale)).join(', ')}</li>}
              </ul>
            </div>
            {!coach.is_self && <div className="mk-hero-report"><MarketplaceReport targetType="coach" targetId={coach.coach_id} reported={coach.viewer.reported_coach} /></div>}
          </section>

          {coach.bio && <section className="panel"><div className="panel-heading"><h3>{t('mkAbout')}</h3></div><p className="mk-bio" dir="auto">{coach.bio}</p></section>}
          {(coach.specialties.length > 0 || coach.certifications.length > 0) && (
            <section className="panel mk-lists">
              {coach.specialties.length > 0 && (
                <div><h4>{t('mkSpecialtiesTitle')}</h4><div className="mk-chips">{coach.specialties.map((name) => <span className="soft-badge badge-blue" key={name} dir="auto">{name}</span>)}</div></div>
              )}
              {coach.certifications.length > 0 && (
                <div><h4>{t('mkCertificationsTitle')}</h4><ul className="mk-cert-list">{coach.certifications.map((name) => <li key={name} dir="auto">{name}</li>)}</ul></div>
              )}
            </section>
          )}
          {coach.intro_video_url && <section className="panel"><div className="panel-heading"><h3>{t('mkIntroVideoTitle')}</h3></div><MarketplaceVideo url={coach.intro_video_url} /></section>}
          <Reviews coach={coach} reviews={reviews} onChanged={refresh} onMore={() => load(reviews.items.length + REVIEW_PAGE)} />
        </div>
        <aside className="mk-detail-side">
          <ContactPanel coach={coach} onChanged={refresh} />
        </aside>
      </div>
    </>
  );
}
