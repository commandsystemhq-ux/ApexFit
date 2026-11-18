export const REACTIONS = [
  { id: 'like', emoji: '👍', labelKey: 'reactionLike' },
  { id: 'fire', emoji: '🔥', labelKey: 'reactionFire' },
  { id: 'clap', emoji: '👏', labelKey: 'reactionClap' },
];

export const BADGES = [
  { code: 'first_workout', icon: '🏁' },
  { code: 'workouts_10', icon: '💪' },
  { code: 'workouts_50', icon: '🏆' },
  { code: 'streak_7', icon: '🔥' },
  { code: 'streak_30', icon: '⚡' },
  { code: 'food_7', icon: '🥗' },
  { code: 'points_500', icon: '⭐' },
  { code: 'points_2000', icon: '👑' },
];

export const POINT_RULES = [
  { source: 'workout', points: 50, labelKey: 'earnWorkout' },
  { source: 'food', points: 5, labelKey: 'earnFood' },
  { source: 'habit', points: 10, labelKey: 'earnHabit' },
  { source: 'metric', points: 10, labelKey: 'earnMetric' },
  { source: 'task', points: 20, labelKey: 'earnTask' },
];

export const LEADERBOARD_PERIODS = [
  { id: 'week', labelKey: 'leaderboardWeek' },
  { id: 'month', labelKey: 'leaderboardMonth' },
  { id: 'all', labelKey: 'leaderboardAll' },
];

export function normalizeDisplayName(name) {
  const value = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (value.length < 2 || value.length > 40) throw new RangeError('Display name must be between 2 and 40 characters.');
  return value;
}

export function suggestDisplayName(user) {
  const fullName = user?.user_metadata?.full_name;
  const source = typeof fullName === 'string' && fullName.trim() ? fullName : user?.email?.split('@')[0] || '';
  return source.trim().split(/\s+/)[0]?.slice(0, 40) || '';
}

export function normalizePostBody(body, { allowEmpty = false, maxLength = 1000 } = {}) {
  const value = typeof body === 'string' ? body.trim() : '';
  if (!value && !allowEmpty) throw new TypeError('Write something to share.');
  if (value.length > maxLength) throw new RangeError(`Posts cannot exceed ${maxLength} characters.`);
  return value;
}

export function normalizeComment(body) {
  const value = typeof body === 'string' ? body.trim() : '';
  if (!value) throw new TypeError('Write a comment first.');
  if (value.length > 500) throw new RangeError('Comments cannot exceed 500 characters.');
  return value;
}

export function getLevelProgress(summary) {
  const per = summary?.points_per_level || 250;
  const into = summary?.points_into_level || 0;
  return {
    level: summary?.level || 1,
    into,
    per,
    remaining: Math.max(per - into, 0),
    percent: Math.min(100, Math.round((into / per) * 100)),
  };
}

// Optimistic reaction update: picking the same reaction again removes it.
export function applyReaction(post, reaction) {
  const reactions = { ...post.reactions };
  const previous = post.my_reaction;
  if (previous) {
    reactions[previous] = Math.max((reactions[previous] || 1) - 1, 0);
    if (reactions[previous] === 0) delete reactions[previous];
  }
  const next = previous === reaction ? null : reaction;
  if (next) reactions[next] = (reactions[next] || 0) + 1;
  return { ...post, reactions, my_reaction: next };
}

export function totalReactions(post) {
  return Object.values(post.reactions || {}).reduce((sum, count) => sum + Number(count), 0);
}

export function formatRelativeTime(isoDate, locale = 'en', now = Date.now()) {
  const seconds = Math.round((new Date(isoDate).getTime() - now) / 1000);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(0, 'second');
}

export function mergeFeedPage(current, page) {
  const known = new Set(current.map((post) => post.post_id));
  return [...current, ...page.filter((post) => !known.has(post.post_id))];
}
