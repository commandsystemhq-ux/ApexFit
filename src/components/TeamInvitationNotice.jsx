import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from './Button.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { acceptTeamInvitation, declineTeamInvitation, getMyTeamInvitations } from '../services/teamService.js';
import { teamErrorText } from '../services/teamErrors.js';
import { PAGES, roleOf } from '../routes.js';

// For a coach account: invitations from a head coach to join their team of assistant trainers.
export default function TeamInvitationNotice() {
  const { t } = useLocale();
  const showToast = useToast();
  const navigate = useNavigate();
  const { profile, user, setProfile } = useAuth();
  const [invitations, setInvitations] = useState([]);
  const [busyId, setBusyId] = useState('');
  const isCoach = roleOf(profile) === 'coach';

  useEffect(() => {
    if (!isCoach) {
      setInvitations([]);
      return undefined;
    }
    let active = true;
    getMyTeamInvitations()
      .then((rows) => {
        if (active) setInvitations(rows);
      })
      .catch(() => {
        if (active) setInvitations([]);
      });
    return () => { active = false; };
  }, [isCoach, user?.id]);

  async function respond(invitation, accept) {
    setBusyId(invitation.id);
    try {
      if (accept) {
        setProfile(await acceptTeamInvitation(invitation.id));
        showToast(t('tmAccepted'));
        navigate(PAGES.teamClients.path);
      } else {
        await declineTeamInvitation(invitation.id);
        setInvitations((current) => current.filter((item) => item.id !== invitation.id));
      }
    } catch (error) {
      showToast(`${t('tmInviteActionError')} ${teamErrorText(error, t)}`);
    } finally {
      setBusyId('');
    }
  }

  if (invitations.length === 0) return null;
  return (
    <div className="onboarding-notices">
      {invitations.map((invitation) => (
        <div className="notice notice-info onboarding-notice" key={invitation.id} role="status">
          <span dir="auto">
            <strong>{invitation.head_name}</strong> {t('tmInviteFrom')}{invitation.role_title ? ` ${t('tmAsRole')} ${invitation.role_title}` : ''}
          </span>
          <span className="wf-actions">
            <Button variant="primary" size="small" disabled={busyId === invitation.id} onClick={() => respond(invitation, true)}>{t('tmAccept')}</Button>
            <Button variant="secondary" size="small" disabled={busyId === invitation.id} onClick={() => respond(invitation, false)}>{t('tmDecline')}</Button>
          </span>
        </div>
      ))}
    </div>
  );
}
