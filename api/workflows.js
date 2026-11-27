import { adminClient } from './_lib/auth.js';
import { env } from './_lib/config.js';
import { isAuthorizedCron } from './_lib/cron.js';
import { HttpError, handler } from './_lib/http.js';
import { deliverReminderPushes } from './_lib/pushNotify.js';

// Scheduled entry point for the workflow engine: queues missed-workout and milestone workflows
// and delivers every step that is due. Not needed when pg_cron runs public.run_workflow_engine().
// It also turns due custom reminders into notifications and sends them as Web Push (the same job, so no extra function).
export default handler(['GET', 'POST'], async (req, res) => {
  if (!isAuthorizedCron(req.headers.authorization, env('CRON_SECRET'))) {
    throw new HttpError(401, 'Unauthorized.');
  }
  const admin = adminClient();
  const { data, error } = await admin.rpc('run_workflow_engine');
  if (error) throw error;
  res.status(200).json({ ...data, reminders: await runReminders(admin) });
});
// Reminder trouble (a missing function, no push keys) is reported in the answer and never fails the workflow run.
async function runReminders(admin) {
  try {
    const { data, error } = await admin.rpc('run_reminder_engine');
    if (error) throw error;
    return await deliverReminderPushes(data);
  } catch (error) {
    return { due: 0, sent: 0, error: 'Reminders could not be processed.' };
  }
}
