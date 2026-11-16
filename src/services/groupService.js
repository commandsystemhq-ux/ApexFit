import { requireSupabase } from './supabaseClient.js';

export async function listGroups() {
  const { data, error } = await requireSupabase()
    .from('coaching_groups')
    .select('id,name,description,program_template_id,created_at,members:coaching_group_members(client_id,joined_at),announcements:group_announcements(id,body,created_at)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getMyGroups() {
  const { data, error } = await requireSupabase().rpc('get_my_groups');
  if (error) throw error;
  return data || [];
}

export async function saveGroup({ id = null, name, description }) {
  const { data, error } = await requireSupabase().rpc('save_group', { p_group_id: id, p_name: name, p_description: description });
  if (error) throw error;
  return data;
}

export async function deleteGroup(groupId) {
  const { error } = await requireSupabase().rpc('delete_group', { p_group_id: groupId });
  if (error) throw error;
}

export async function addGroupMembers(groupId, clientIds) {
  const { data, error } = await requireSupabase().rpc('add_group_members', { p_group_id: groupId, p_client_ids: clientIds });
  if (error) throw error;
  return data;
}

export async function removeGroupMember(groupId, clientId) {
  const { error } = await requireSupabase().rpc('remove_group_member', { p_group_id: groupId, p_client_id: clientId });
  if (error) throw error;
}

export async function assignProgramToGroup(groupId, programId) {
  const { data, error } = await requireSupabase().rpc('assign_program_to_group', { p_group_id: groupId, p_program_id: programId });
  if (error) throw error;
  return data;
}

export async function clearGroupProgram(groupId) {
  const { error } = await requireSupabase().rpc('clear_group_program', { p_group_id: groupId });
  if (error) throw error;
}

export async function postGroupAnnouncement(groupId, body) {
  const { data, error } = await requireSupabase().rpc('post_group_announcement', { p_group_id: groupId, p_body: body });
  if (error) throw error;
  return data;
}

export async function deleteGroupAnnouncement(announcementId) {
  const { error } = await requireSupabase().rpc('delete_group_announcement', { p_announcement_id: announcementId });
  if (error) throw error;
}
