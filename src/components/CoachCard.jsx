import { Link } from 'react-router-dom';
import RatingStars from './RatingStars.jsx';
import UserAvatar from './UserAvatar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillTemplate } from '../services/textTemplate.js';
import { TRAINING_MODE_KEYS, coachPath, languageName, placeLabel } from '../services/marketplaceUtils.js';

// One coach in the search results: only public details (no e-mail, phone or client data ever reach this screen).
export default function CoachCard({ coach }) {
  const { t, locale } = useLocale();
  const place = placeLabel(coach, locale);
  return (
    <article className="panel mk-card">
      <div className="mk-card-head">
        <UserAvatar profile={{ avatar_path: coach.avatar_path, full_name: coach.display_name }} />
        <div className="mk-card-title">
          <h3 dir="auto">{coach.display_name || t('mkSomeone')}</h3>
          <p className="muted-copy" dir="auto">{coach.headline}</p>
        </div>
      </div>
      {coach.rating_count > 0
        ? <RatingStars value={coach.rating_avg} count={coach.rating_count} label={t('mkFilterRating')} />
        : <small className="muted-copy">{t('mkNoReviewsYet')}</small>}
      <p className="mk-card-summary" dir="auto">{coach.summary}</p>
      <div className="mk-chips">
        {(coach.specialties || []).slice(0, 4).map((name) => <span className="soft-badge badge-blue" key={name} dir="auto">{name}</span>)}
      </div>
      <ul className="mk-facts">
        {place && <li dir="auto">{place}</li>}
        <li>{t(TRAINING_MODE_KEYS[coach.training_mode] || 'mkModeOnline')}</li>
        {coach.years_experience !== null && coach.years_experience !== undefined && <li>{fillTemplate(t('mkYearsShort'), { count: coach.years_experience })}</li>}
        {(coach.languages || []).length > 0 && <li>{coach.languages.map((code) => languageName(code, locale)).join(', ')}</li>}
      </ul>
      <div className="mk-card-foot">
        <span className={`soft-badge ${coach.accepting_clients ? 'badge-green' : 'badge-muted'}`}>{t(coach.accepting_clients ? 'mkAcceptingBadge' : 'mkFullBadge')}</span>
        <Link className="button button-primary button-small" to={coachPath(coach.coach_id)}>{t('mkViewProfile')}</Link>
      </div>
    </article>
  );
}
