import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import ProgressBar from './ProgressBar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { createPost, getMyGamification } from '../services/communityService.js';
import { BADGES, POINT_RULES, getLevelProgress } from '../services/communityUtils.js';

export default function CommunityAchievements({ communityId, onShared }) {
  const { t } = useLocale();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    getMyGamification()
      .then((result) => {
        if (active) setSummary(result);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => { active = false; };
  }, []);

  async function share(code) {
    setSharing(code);
    setMessage('');
    setError('');
    try {
      await createPost(communityId, { kind: 'achievement', achievementCode: code });
      setMessage(t('badgeShared'));
      onShared();
    } catch (shareError) {
      setError(`${t('badgeShareError')} ${shareError.message}`);
    } finally {
      setSharing('');
    }
  }

  const progress = getLevelProgress(summary);
  const earned = new Set(summary?.badges || []);

  return (
    <div className="client-progress-layout">
      <section className="panel level-card">
        <div className="panel-heading"><div><span className="eyebrow">{t('communityProgressTab')}</span><h3>{t('levelLabel')} {progress.level}</h3></div></div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {message && <div className="notice notice-info" role="status">{message}</div>}
        {!summary && !error && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {summary && (
          <>
            <ProgressBar value={progress.percent} color="green" />
            <p className="muted-copy">{progress.remaining} {t('pointsToNext')}</p>
            <dl className="strength-stats">
              <div><dt>{t('totalPointsLabel')}</dt><dd>{summary.total_points.toLocaleString()}</dd></div>
              <div><dt>{t('weekPointsLabel')}</dt><dd>{summary.week_points.toLocaleString()}</dd></div>
              <div><dt>{t('streakLabel')}</dt><dd>{summary.current_streak} {t('daysWord')}</dd></div>
              <div><dt>{t('longestStreakLabel')}</dt><dd>{summary.longest_streak} {t('daysWord')}</dd></div>
            </dl>
          </>
        )}
        <h4 className="subheading">{t('howToEarn')}</h4>
        <ul className="earn-list">
          {POINT_RULES.map((rule) => (
            <li key={rule.source}><span>{t(rule.labelKey)}</span><strong>+{rule.points} {t('pointsAbbr')}</strong></li>
          ))}
        </ul>
        <p className="muted-copy">{t('pointsRulesNote')}</p>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('communityProgressTab')}</span><h3>{t('badgesTitle')}</h3></div></div>
        <div className="badge-grid">
          {BADGES.map((badge) => {
            const isEarned = earned.has(badge.code);
            return (
              <article className={`badge-card ${isEarned ? 'is-earned' : ''}`} key={badge.code}>
                <span className="badge-icon" aria-hidden="true">{badge.icon}</span>
                <strong>{t(`badge_${badge.code}`)}</strong>
                <small>{t(`badgeDesc_${badge.code}`)}</small>
                {isEarned
                  ? <Button variant="secondary" size="small" disabled={sharing === badge.code} onClick={() => share(badge.code)}>{t('badgeShare')}</Button>
                  : <span className="soft-badge badge-muted">{t('badgeLocked')}</span>}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
