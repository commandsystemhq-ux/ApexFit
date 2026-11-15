import { useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { joinCommunity } from '../services/communityService.js';

export default function CommunityProfileForm({ initial, showLeaderboardOption, isEditing, onSaved, onCancel }) {
  const { t } = useLocale();
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [leaderboardOptIn, setLeaderboardOptIn] = useState(initial.leaderboardOptIn);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await joinCommunity({ displayName, leaderboardOptIn });
      onSaved({ display_name: displayName.trim().replace(/\s+/g, ' '), leaderboard_opt_in: leaderboardOptIn });
    } catch (saveError) {
      setError(`${t('communityProfileError')} ${saveError.message}`);
      setSaving(false);
    }
  }

  return (
    <form className="panel community-profile-form" onSubmit={handleSubmit}>
      <div className="panel-heading"><div><span className="eyebrow">{t('community')}</span><h3>{t(isEditing ? 'communityEditProfile' : 'communityJoinTitle')}</h3></div></div>
      <p className="muted-copy">{t('communityJoinHelp')}</p>
      <label className="form-label">{t('communityDisplayName')}
        <input className="field" value={displayName} minLength={2} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} required autoFocus />
      </label>
      {showLeaderboardOption && (
        <label className="checkbox-row">
          <input type="checkbox" checked={leaderboardOptIn} onChange={(event) => setLeaderboardOptIn(event.target.checked)} />
          {t('communityLeaderboardOptIn')}
        </label>
      )}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="community-form-actions">
        <Button variant="primary" type="submit" disabled={saving}>{saving ? t('communitySaving') : t(isEditing ? 'communitySaveProfile' : 'communityJoinSave')}</Button>
        {isEditing && <Button variant="secondary" type="button" onClick={onCancel}>{t('communityCancel')}</Button>}
      </div>
    </form>
  );
}
