import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import CommunityAchievements from '../components/CommunityAchievements.jsx';
import CommunityFeed from '../components/CommunityFeed.jsx';
import CommunityLeaderboard from '../components/CommunityLeaderboard.jsx';
import CommunityProfileForm from '../components/CommunityProfileForm.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyCoaches } from '../services/coachClientService.js';
import { getMyCommunityProfile } from '../services/communityService.js';
import { suggestDisplayName } from '../services/communityUtils.js';
import { PAGES } from '../routes.js';

export default function CommunityPage({ view = 'feed' }) {
  const { t } = useLocale();
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const isCoach = profile?.role === 'coach';
  const isClient = profile?.role === 'client';
  const [coaches, setCoaches] = useState(null);
  const [communityId, setCommunityId] = useState('');
  const [member, setMember] = useState(undefined);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !profile) return undefined;
    let active = true;
    if (isCoach) {
      setCommunityId(user.id);
    } else if (isClient) {
      listMyCoaches()
        .then((rows) => {
          if (!active) return;
          const activeCoaches = rows.filter((row) => row.status === 'active');
          setCoaches(activeCoaches);
          setCommunityId(activeCoaches[0]?.coach_id || '');
        })
        .catch((loadError) => {
          if (active) setError(loadError.message);
        });
    }
    getMyCommunityProfile()
      .then((row) => {
        if (active) setMember(row);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => { active = false; };
  }, [user?.id, profile?.role]);

  const tabs = [
    { id: 'community', label: 'communityFeedTab', icon: '💬' },
    { id: 'leaderboard', label: 'communityLeaderboardTab', icon: '🏆' },
  ];

  let body = null;
  if (error) {
    body = <div className="notice notice-error" role="alert">{t('communityLoadError')} {error}</div>;
  } else if (!profile || member === undefined || (isClient && coaches === null)) {
    body = <div className="notice notice-info" role="status">{t('accountLoading')}</div>;
  } else if (isClient && coaches.length === 0) {
    body = (
      <section className="panel">
        <div className="dashboard-empty">
          <p>{t('communityNoCoach')}</p>
          <Button variant="primary" onClick={() => navigate(PAGES.coachHub.path)}>{t('coachHub')}</Button>
        </div>
      </section>
    );
  } else if (!member || editing) {
    body = (
      <CommunityProfileForm
        initial={{ displayName: member?.display_name || suggestDisplayName(user), leaderboardOptIn: member?.leaderboard_opt_in ?? true }}
        showLeaderboardOption={isClient}
        isEditing={Boolean(member)}
        onCancel={() => setEditing(false)}
        onSaved={(saved) => {
          setMember(saved);
          setEditing(false);
        }}
      />
    );
  } else {
    body = (
      <>
        {isClient && coaches.length > 1 && (
          <label className="form-label community-switcher">{t('communityCoachSelect')}
            <select className="field" value={communityId} onChange={(event) => setCommunityId(event.target.value)}>
              {coaches.map((coach) => <option key={coach.coach_id} value={coach.coach_id}>{coach.coach_name || coach.coach_email}</option>)}
            </select>
          </label>
        )}
        <div className="community-toolbar">
          <nav className="client-feature-tabs" aria-label={t('community')}>
            {tabs.map(({ id, label, icon }) => (
              <NavLink key={id} to={PAGES[id].path} className={({ isActive }) => `client-feature-tab ${isActive ? 'is-active' : ''}`}>
                <span aria-hidden="true">{icon}</span>{t(label)}
              </NavLink>
            ))}
          </nav>
          <button className="text-action" type="button" onClick={() => setEditing(true)}>{member.display_name} · {t('communityEditProfile')}</button>
        </div>
        {view === 'feed' && <CommunityFeed communityId={communityId} isCoach={isCoach} />}
        {view === 'leaderboard' && (
          <>
            <CommunityLeaderboard communityId={communityId} leaderboardOptIn={isClient ? member.leaderboard_opt_in : true} />
            {isClient && <CommunityAchievements communityId={communityId} onShared={() => navigate(PAGES.community.path)} />}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={view === 'leaderboard' ? t('leaderboardPage') : t('community')} description={view === 'leaderboard' ? t('leaderboardDescription') : t('communityDescription')} />
      {body}
    </>
  );
}
