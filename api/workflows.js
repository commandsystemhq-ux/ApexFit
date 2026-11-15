import { adminClient } from './_lib/auth.js';
import { env } from './_lib/config.js';
import { isAuthorizedCron } from './_lib/cron.js';
import { HttpError, handler } from './_lib/http.js';

// Scheduled entry point for the workflow engine: queues missed-workout and milestone workflows
// and delivers every step that is due. Not needed when pg_cron runs public.run_workflow_engine().
export default handler(['GET', 'POST'], async (req, res) => {
  if (!isAuthorizedCron(req.headers.authorization, env('CRON_SECRET'))) {
    throw new HttpError(401, 'Unauthorized.');
  }
  const { data, error } = await adminClient().rpc('run_workflow_engine');
  if (error) throw error;
  res.status(200).json(data);
});