import { requireSupabase } from './supabaseClient.js';

const WORKFLOW_FIELDS = `
  id,name,description,trigger_type,is_active,created_at,
  steps:workflow_steps(id,step_order,delay_days,action_type,message_template,task_title)
`;

export async function listWorkflows() {
  const { data, error } = await requireSupabase()
    .from('workflows')
    .select(WORKFLOW_FIELDS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((workflow) => ({
    ...workflow,
    steps: [...(workflow.steps || [])].sort((left, right) => left.step_order - right.step_order),
  }));
}

export async function listWorkflowLogs(limit = 1000) {
  const { data, error } = await requireSupabase()
    .from('workflow_logs')
    .select('workflow_id,status')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function saveWorkflow({ id = null, name, description, trigger_type, is_active, steps }) {
  const { data, error } = await requireSupabase().rpc('save_workflow', {
    p_workflow_id: id,
    p_name: name,
    p_description: description,
    p_trigger_type: trigger_type,
    p_is_active: is_active,
    p_steps: steps,
  });
  if (error) throw error;
  return data;
}

export async function setWorkflowActive(workflowId, isActive) {
  const { error } = await requireSupabase().rpc('set_workflow_active', {
    p_workflow_id: workflowId,
    p_is_active: isActive,
  });
  if (error) throw error;
}

export async function deleteWorkflow(workflowId) {
  const { error } = await requireSupabase().rpc('delete_workflow', { p_workflow_id: workflowId });
  if (error) throw error;
}

// Processes this coach's due steps right away (missed workouts, milestones, delayed steps).
export async function runMyWorkflows() {
  const { data, error } = await requireSupabase().rpc('run_my_workflow_engine');
  if (error) throw error;
  return data;
}

export async function assignProgramToClient(clientId, programId) {
  const { data, error } = await requireSupabase().rpc('assign_program_to_client', {
    p_client_id: clientId,
    p_program_id: programId,
  });
  if (error) throw error;
  return data;
}
