export const GROUP_LIMITS = { name: 80, description: 500, announcement: 1000, members: 100 };

export function validateGroupForm({ name, description }) {
  const errors = {};
  const cleanName = String(name ?? '').trim();
  const cleanDescription = String(description ?? '').trim();

  if (!cleanName) errors.name = 'grpErrName';
  else if (cleanName.length > GROUP_LIMITS.name) errors.name = 'grpErrNameLength';
  if (cleanDescription.length > GROUP_LIMITS.description) errors.description = 'grpErrDescription';

  return { valid: Object.keys(errors).length === 0, errors, payload: { name: cleanName, description: cleanDescription } };
}

export function validateAnnouncement(body) {
  const clean = String(body ?? '').trim();
  if (!clean) return { valid: false, error: 'grpErrAnnouncement', body: clean };
  if (clean.length > GROUP_LIMITS.announcement) return { valid: false, error: 'grpErrAnnouncementLength', body: clean };
  return { valid: true, error: '', body: clean };
}

// Active clients who are not yet in the group.
export function availableClients(clients, memberIds) {
  const members = new Set(memberIds);
  return (clients || []).filter((client) => client.status === 'active' && !members.has(client.client_id));
}

// Turns the raw group rows (with members and announcements) into what the page renders.
export function describeGroup(group, clients, programs) {
  const byId = new Map((clients || []).map((client) => [client.client_id, client]));
  const members = [...(group.members || [])]
    .sort((left, right) => new Date(left.joined_at) - new Date(right.joined_at))
    .map((member) => ({
      client_id: member.client_id,
      joined_at: member.joined_at,
      client: byId.get(member.client_id) || null,
    }));
  const program = (programs || []).find((item) => item.id === group.program_template_id) || null;
  const announcements = [...(group.announcements || [])].sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
  return { ...group, members, program, announcements, activeMemberCount: members.filter((member) => member.client?.status === 'active').length };
}
