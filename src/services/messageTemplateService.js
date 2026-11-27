import { requireSupabase } from './supabaseClient.js';

async function call(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// The coach's templates. Row-level security keeps it to their own.
export async function listMessageTemplates() {
  const { data, error } = await requireSupabase()
    .from('coach_message_templates')
    .select('id,title,category,body,updated_at')
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return data || [];
}

export const saveMessageTemplate = ({ id = null, title, category, body }) => call('save_message_template', { p_id: id, p_title: title, p_category: category, p_body: body });
export const deleteMessageTemplate = (id) => call('delete_message_template', { p_id: id });
