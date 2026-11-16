import { authenticate, requireRole } from './_lib/auth.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { scheduleVideoSession } from './_lib/videoSessions.js';
import { isZoomConfigured } from './_lib/zoom.js';

export default handler(['POST'], async (req, res) => {
  const context = await authenticate(req);
  const body = await readJson(req);
  await requireRole(context.userClient, 'coach');

  if (body.action === 'config') {
    return res.status(200).json({ zoom: isZoomConfigured() });
  }
  if (body.action === 'schedule') {
    return res.status(200).json(await scheduleVideoSession(context, body));
  }
  throw new HttpError(400, 'Unknown action.');
});