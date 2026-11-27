import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export async function listClientTags() {
  const { data, error } = await requireSupabase().from('client_tags').select('id,name,color,kind,created_at').order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// [{ client_id, tag_id }] for all the coach's clients.
export async function listClientTagAssignments() {
  const { data, error } = await requireSupabase().from('client_tag_assignments').select('client_id,tag_id');
  if (error) throw error;
  return data || [];
}

export const saveClientTag = ({ id = null, name, color, kind }) => rpc('save_client_tag', { p_tag_id: id, p_name: name, p_color: color, p_kind: kind });

export const deleteClientTag = (tagId) => rpc('delete_client_tag', { p_tag_id: tagId });

export const setClientTags = (clientId, tagIds) => rpc('set_client_tags', { p_client_id: clientId, p_tag_ids: tagIds });
