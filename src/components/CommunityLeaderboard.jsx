import { useEffect, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLeaderboard } from '../services/communityService.js';
import { LEADERBOARD_PERIODS } from '../services/communityUtils.js';

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

export default function CommunityLeaderboard({ communityId, leaderboardOptIn }) {
  const { t } = useLocale();
  const [period, setPeriod] = useState('week');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    getLeaderboard(communityId, period)
      .then((result) => {
        if (!active) return;
        setRows(result);
        setError('');
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [communityId, period]);

  return (
    <section className="panel leaderboard-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">{t('community')}</span><h3>{t('leaderboardTitle')}</h3></div>
        <div className="range-switch" role="group" aria-label={t('leaderboardTitle')}>
          {LEADERBOARD_PERIODS.map(({ id, labelKey }) => (
            <button key={id} type="button" className={period === id ? 'is-active' : ''} aria-pressed={period === id} onClick={() => setPeriod(id)}>{t(labelKey)}</button>
          ))}
        </div>
      </div>
      {leaderboardOptIn === false && <div className="notice notice-info" role="status">{t('leaderboardHidden')}</div>}
      {error && <div className="notice notice-error" role="alert">{t('leaderboardError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && rows.length === 0 && <div className="empty-state">{t('leaderboardEmpty')}</div>}
      <ol className="leaderboard-list">
        {rows.map((row) => (
          <li className={`leaderboard-row ${row.lb_is_me ? 'is-me' : ''}`} key={row.lb_user_id} value={Number(row.lb_rank)}>
            <span className={`leaderboard-rank rank-${Math.min(Number(row.lb_rank), 4)}`}>{MEDALS[Number(row.lb_rank)] || Number(row.lb_rank)}</span>
            <div className="avatar avatar-blue" aria-hidden="true">{row.lb_display_name.slice(0, 1).toUpperCase()}</div>
            <div className="leaderboard-name">
              <strong>{row.lb_display_name}{row.lb_is_me ? ` (${t('leaderboardYou')})` : ''}</strong>
              <small>{t('levelLabel')} {row.lb_level}</small>
            </div>
            <strong className="leaderboard-points">{Number(row.lb_points).toLocaleString()} <small>{t('pointsAbbr')}</small></strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
