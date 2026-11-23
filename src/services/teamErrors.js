// The database explains refusals in English. Each known sentence maps to a translation key so the person reads it in
// their own language; anything unknown is shown as the database wrote it.
const TEAM_ERRORS = {
  'An active coach account is required to manage a team': 'tmErr_needManage',
  'Enter a valid email address': 'tmErr_invalidEmail',
  'You cannot invite yourself': 'tmErr_inviteSelf',
  'The role title can be at most 80 characters': 'tmErr_roleTitle',
  'A team can have at most 10 trainers': 'tmErr_maxTrainers',
  'This email has already been invited': 'tmErr_alreadyInvited',
  'Team member was not found': 'tmErr_memberNotFound',
  'Unsupported status': 'tmErr_unsupportedStatus',
  'Wait until the trainer accepts the invitation': 'tmErr_waitAccept',
  'Choose an active client': 'tmErr_chooseClient',
  'Choose an active trainer': 'tmErr_chooseTrainer',
  'A coach account is required': 'tmErr_coachRequired',
  'A coach account is required to join a team': 'tmErr_coachRequiredJoin',
  'This invitation is not available': 'tmErr_invitationUnavailable',
  'This account already runs its own coaching practice, so it cannot join a team': 'tmErr_ownPractice',
  'This account already has its own team, so it cannot join another one': 'tmErr_ownTeam',
  'You already belong to a team': 'tmErr_alreadyInTeam',
  'Authentication is required': 'tmErr_authRequired',
  'You are not part of an active team': 'tmErr_notInTeam',
  'You do not have permission to message clients': 'tmErr_noMessagePermission',
  'That client is not assigned to you': 'tmErr_clientNotAssigned',
  'Write a message of up to 2000 characters': 'tmErr_messageLength',
  'An active coach account is required to assign programs': 'tmErr_needAssign',
  'Program was not found': 'tmErr_programNotFound',
  'An active coach account is required to manage groups': 'tmErr_needGroups',
  'Group was not found': 'tmErr_groupNotFound',
  'Choose at least one client': 'tmErr_chooseOneClient',
  'Only your active clients can be added to a group': 'tmErr_groupOnlyActive',
  'You can only add clients assigned to you': 'tmErr_groupAssignedOnly',
  'A group can have at most 100 members': 'tmErr_groupMax',
  'You can only manage clients assigned to you': 'tmErr_manageAssignedOnly',
  'That client is not in this group': 'tmErr_notInGroup',
  'Write an update of up to 1000 characters': 'tmErr_announcementLength',
  'You are posting too quickly. Try again later': 'tmErr_postingFast',
};

export const TEAM_ERROR_MESSAGES = Object.freeze(Object.keys(TEAM_ERRORS));
export const TEAM_ERROR_KEYS = Object.freeze(Object.values(TEAM_ERRORS));

const clean = (message) => String(message ?? '').trim().replace(/\.$/, '');

export function teamErrorKey(error) {
  return TEAM_ERRORS[clean(error?.message ?? error)] ?? null;
}

// The error in the person's language when the database sentence is known, otherwise the original text.
export function teamErrorText(error, t) {
  const key = teamErrorKey(error);
  return key ? t(key) : String(error?.message ?? error ?? '');
}
