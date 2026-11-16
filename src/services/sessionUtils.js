export const SESSION_PROVIDERS = ['apexfit_live', 'zoom', 'google_meet', 'custom'];
export const SESSION_LIMITS = { title: 120, description: 1000, passcode: 50, minDuration: 5, maxDuration: 480 };
export const JOIN_OPENS_MINUTES = 10;

const ZOOM_HOST = /^https:\/\/([a-z0-9-]+\.)*(zoom\.us|zoom\.com|zoomgov\.com)(\/|\?|$)/i;
const MEET_HOST = /^https:\/\/meet\.google\.com(\/|\?|$)/i;

// The built-in ApexFit Live room has no external link; every other provider does.
export function needsMeetingLink(provider) {
  return provider !== 'apexfit_live';
}

export function isValidMeetingUrl(url) {
  return typeof url === 'string' && url.length <= 500 && /^https:\/\/[^\s<>"]+$/.test(url);
}

// Same rule as the database: a Zoom link must be on a Zoom domain, a Meet link on meet.google.com.
export function linkMatchesProvider(provider, url) {
  if (!isValidMeetingUrl(url)) return false;
  if (provider === 'zoom') return ZOOM_HOST.test(url);
  if (provider === 'google_meet') return MEET_HOST.test(url);
  return provider === 'custom';
}

// <input type="datetime-local"> works in local time without a zone.
export function toDatetimeLocal(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function fromDatetimeLocal(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function emptySessionDraft(overrides = {}) {
  return {
    id: null, audience: 'client', clientId: '', groupId: '', title: '', description: '',
    scheduledAt: '', duration: '60', provider: 'apexfit_live', meetingUrl: '', passcode: '', autoLink: true, ...overrides,
  };
}

export function validateSessionForm(form, { zoomConfigured = false, now = Date.now() } = {}) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  const description = String(form.description ?? '').trim();
  const url = String(form.meetingUrl ?? '').trim();
  const passcode = String(form.passcode ?? '').trim();
  const duration = Number(form.duration);
  const scheduledAt = fromDatetimeLocal(form.scheduledAt);
  const generate = form.provider === 'zoom' && zoomConfigured && form.autoLink && !url;

  if (form.audience === 'group' ? !form.groupId : !form.clientId) errors.audience = form.audience === 'group' ? 'vsErrGroup' : 'vsErrClient';
  if (!title) errors.title = 'vsErrTitle';
  else if (title.length > SESSION_LIMITS.title) errors.title = 'vsErrTitleLength';
  if (description.length > SESSION_LIMITS.description) errors.description = 'vsErrDescription';
  if (!scheduledAt) errors.scheduledAt = 'vsErrDate';
  else if (!form.id && new Date(scheduledAt).getTime() < now - 3_600_000) errors.scheduledAt = 'vsErrPast';
  if (!Number.isInteger(duration) || duration < SESSION_LIMITS.minDuration || duration > SESSION_LIMITS.maxDuration) errors.duration = 'vsErrDuration';
  if (!SESSION_PROVIDERS.includes(form.provider)) errors.provider = 'vsErrProvider';
  if (needsMeetingLink(form.provider) && !generate) {
    if (!url) errors.meetingUrl = 'vsErrLink';
    else if (!isValidMeetingUrl(url)) errors.meetingUrl = 'vsErrLinkSecure';
    else if (!linkMatchesProvider(form.provider, url)) errors.meetingUrl = 'vsErrLinkProvider';
  }
  if (needsMeetingLink(form.provider) && passcode.length > SESSION_LIMITS.passcode) errors.passcode = 'vsErrPasscode';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    generate,
    payload: {
      id: form.id ?? null,
      clientId: form.audience === 'client' ? form.clientId : null,
      groupId: form.audience === 'group' ? form.groupId : null,
      title,
      description,
      scheduledAt,
      durationMinutes: duration,
      provider: form.provider,
      meetingUrl: needsMeetingLink(form.provider) ? url : '',
      passcode: needsMeetingLink(form.provider) ? passcode : '',
    },
  };
}

export function sessionEnd(session) {
  return new Date(session.scheduled_at).getTime() + Number(session.duration_minutes) * 60_000;
}

// upcoming → soon (join opens) → live → ended. Cancelled and completed sessions keep their own state.
export function sessionPhase(session, now = Date.now()) {
  if (session.status === 'cancelled') return 'cancelled';
  if (session.status === 'completed') return 'completed';
  const start = new Date(session.scheduled_at).getTime();
  if (now >= sessionEnd(session)) return 'ended';
  if (now >= start) return 'live';
  if (start - now <= JOIN_OPENS_MINUTES * 60_000) return 'soon';
  return 'upcoming';
}

export function countdownParts(target, now = Date.now()) {
  const remaining = Math.max(0, new Date(target).getTime() - now);
  const totalSeconds = Math.floor(remaining / 1000);
  return {
    done: remaining === 0,
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

// "2d 3h", "3h 05m", "12m 30s": the two most useful units for the remaining time.
export function formatCountdown(parts) {
  const pad = (value) => String(value).padStart(2, '0');
  if (parts.days > 0) return `${parts.days}d ${parts.hours}h`;
  if (parts.hours > 0) return `${parts.hours}h ${pad(parts.minutes)}m`;
  return `${parts.minutes}m ${pad(parts.seconds)}s`;
}

// Sessions the client can still join (or has not reached yet), and the history.
export function splitSessions(sessions, now = Date.now()) {
  const upcoming = [];
  const past = [];
  for (const session of sessions || []) {
    const phase = sessionPhase(session, now);
    (['upcoming', 'soon', 'live'].includes(phase) ? upcoming : past).push(session);
  }
  upcoming.sort((left, right) => new Date(left.scheduled_at) - new Date(right.scheduled_at));
  past.sort((left, right) => new Date(right.scheduled_at) - new Date(left.scheduled_at));
  return { upcoming, past };
}

export function providerLabelKey(provider) {
  return `vsProvider_${provider}`;
}