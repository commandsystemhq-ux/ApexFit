export const TEAM_PERMISSIONS = ['manage_programs', 'view_assessments', 'messages', 'manage_groups'];
export const TEAM_LIMITS = { roleTitle: 80, maxMembers: 10 };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function defaultPermissions() {
  return { manage_programs: true, view_assessments: true, messages: true, manage_groups: false };
}

export function normalizePermissions(value) {
  return Object.fromEntries(TEAM_PERMISSIONS.map((key) => [key, value?.[key] === true]));
}

export function validateInviteForm({ email, roleTitle }) {
  const errors = {};
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  const title = String(roleTitle ?? '').trim();
  if (!EMAIL_PATTERN.test(cleanEmail) || cleanEmail.length > 254) errors.email = 'tmErrEmail';
  if (title.length > TEAM_LIMITS.roleTitle) errors.roleTitle = 'tmErrRoleTitle';
  return { valid: Object.keys(errors).length === 0, errors, email: cleanEmail, roleTitle: title };
}

export function memberLabel(member) {
  return member?.trainer_name || member?.invite_email || '';
}

export function hasPermission(profile, permission) {
  return profile?.team?.permissions?.[permission] === true;
}

// Map of client id → team member, for the "responsible trainer" badge and filter on the clients list.
export function assignmentIndex(assignments, members) {
  const byMember = new Map((members || []).map((member) => [member.id, member]));
  return new Map((assignments || []).map((assignment) => [assignment.client_id, byMember.get(assignment.team_member_id) || null]));
}

export const TRAINER_FILTER_ALL = 'all';
export const TRAINER_FILTER_NONE = 'none';

export function filterClientsByTrainer(clients, index, filter) {
  if (!filter || filter === TRAINER_FILTER_ALL) return clients;
  if (filter === TRAINER_FILTER_NONE) return clients.filter((client) => !index.get(client.client_id));
  return clients.filter((client) => index.get(client.client_id)?.id === filter);
}