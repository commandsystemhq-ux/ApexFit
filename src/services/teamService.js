import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const getTeam = () => rpc('get_team');
export const inviteTrainer = ({ email, roleTitle, permissions }) => rpc('invite_trainer', { p_email: email, p_role_title: roleTitle, p_permissions: permissions });
export const updateTeamMember = ({ memberId, roleTitle, permissions, status = null }) =>
  rpc('update_team_member', { p_member_id: memberId, p_role_title: roleTitle, p_permissions: permissions, p_status: status });
export const removeTeamMember = (memberId) => rpc('remove_team_member', { p_member_id: memberId });
export const assignClientTrainer = (clientId, memberId) => rpc('assign_client_trainer', { p_client_id: clientId, p_member_id: memberId });
export const getMyTeamInvitations = () => rpc('get_my_team_invitations');
export const acceptTeamInvitation = (memberId) => rpc('accept_team_invitation', { p_member_id: memberId });
export const declineTeamInvitation = (memberId) => rpc('decline_team_invitation', { p_member_id: memberId });
export const leaveTeam = () => rpc('leave_team');
export const getTrainerOverview = () => rpc('get_trainer_overview');
export const sendTeamMessage = (clientId, body) => rpc('send_team_message', { p_client_id: clientId, p_body: body });

export async function listAssignments() {
  const { data, error } = await requireSupabase().from('client_trainer_assignments').select('client_id,team_member_id');
  if (error) throw error;
  return data || [];
}