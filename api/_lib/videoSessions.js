import { HttpError } from './http.js';
import { notifyRecipients } from './pushNotify.js';
import { createMeeting, deleteMeeting, isZoomConfigured, ZoomError } from './zoom.js';

const PROVIDERS = ['zoom', 'google_meet', 'custom'];

const defaults = {
  zoom: { isConfigured: isZoomConfigured, createMeeting, deleteMeeting },
  notify: notifyRecipients,
};

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Schedules a one-to-one or group video session as the signed-in coach. With Zoom configured and no link given,
// a meeting is created automatically. The database re-validates everything, so a bad request writes nothing.
export async function scheduleVideoSession(context, input, deps = defaults) {
  const zoom = deps.zoom || defaults.zoom;
  const notify = deps.notify || defaults.notify;

  const provider = PROVIDERS.includes(input.provider) ? input.provider : 'custom';
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw new HttpError(400, 'Choose a date and time for the session.');
  if (scheduledAt.getTime() < Date.now() - 3_600_000) throw new HttpError(400, 'Choose a date and time in the future.');
  const duration = Number(input.durationMinutes ?? 60);
  let meetingUrl = text(input.meetingUrl, 500);
  let passcode = text(input.passcode, 50);
  let createdMeeting = null;

  if (!meetingUrl) {
    if (provider !== 'zoom') throw new HttpError(400, 'Add the meeting link.');
    if (!zoom.isConfigured()) throw new HttpError(503, 'Zoom is not configured. Paste a meeting link instead.');
    try {
      createdMeeting = await zoom.createMeeting({
        title: text(input.title, 120),
        startsAt: scheduledAt.toISOString(),
        durationMinutes: duration,
        passcode,
        description: text(input.description, 1000),
      });
    } catch (error) {
      if (error instanceof ZoomError) throw new HttpError(error.status === 400 ? 400 : 502, error.message);
      throw error;
    }
    meetingUrl = createdMeeting.url;
    passcode = createdMeeting.passcode || passcode;
  }

  const { data, error } = await context.userClient.rpc('schedule_video_session', {
    p_client_id: input.clientId || null,
    p_group_id: input.groupId || null,
    p_title: text(input.title, 200),
    p_description: text(input.description, 1100),
    p_scheduled_at: scheduledAt.toISOString(),
    p_duration_minutes: duration,
    p_provider: provider,
    p_meeting_url: meetingUrl,
    p_meeting_passcode: passcode,
  });
  if (error) {
    if (createdMeeting) await zoom.deleteMeeting(createdMeeting.id);
    throw new HttpError(400, error.message);
  }

  let notified = false;
  if (input.notify !== false) {
    notified = await notify(context, 'video', data).then(() => true).catch(() => false);
  }
  return { id: data, meetingUrl, passcode, provider, generated: Boolean(createdMeeting), notified };
}