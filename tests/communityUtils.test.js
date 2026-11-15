import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReaction,
  formatRelativeTime,
  getLevelProgress,
  mergeFeedPage,
  normalizeComment,
  normalizeDisplayName,
  normalizePostBody,
  suggestDisplayName,
  totalReactions,
} from '../src/services/communityUtils.js';

test('display names are trimmed, collapsed, and bounded', () => {
  assert.equal(normalizeDisplayName('  Sam   Lee '), 'Sam Lee');
  assert.throws(() => normalizeDisplayName('a'), /between 2 and 40/);
  assert.throws(() => normalizeDisplayName('x'.repeat(41)), /between 2 and 40/);
  assert.equal(suggestDisplayName({ user_metadata: { full_name: 'Maya Hassan' } }), 'Maya');
  assert.equal(suggestDisplayName({ email: 'omar.k@example.com' }), 'omar.k');
  assert.equal(suggestDisplayName(null), '');
});

test('posts and comments need content within limits', () => {
  assert.equal(normalizePostBody('  hi  '), 'hi');
  assert.equal(normalizePostBody('', { allowEmpty: true }), '');
  assert.throws(() => normalizePostBody('   '), /Write something/);
  assert.throws(() => normalizePostBody('x'.repeat(1001)), /1000/);
  assert.equal(normalizeComment(' ok '), 'ok');
  assert.throws(() => normalizeComment(' '), /Write a comment/);
  assert.throws(() => normalizeComment('x'.repeat(501)), /500/);
});

test('level progress is bounded and defaults safely', () => {
  assert.deepEqual(getLevelProgress({ level: 3, points_into_level: 100, points_per_level: 250 }), { level: 3, into: 100, per: 250, remaining: 150, percent: 40 });
  assert.equal(getLevelProgress(null).level, 1);
  assert.equal(getLevelProgress({ points_into_level: 999, points_per_level: 250 }).percent, 100);
});

test('optimistic reactions add, switch, and toggle off', () => {
  const post = { reactions: { fire: 2 }, my_reaction: null };
  const liked = applyReaction(post, 'like');
  assert.deepEqual([liked.reactions, liked.my_reaction], [{ fire: 2, like: 1 }, 'like']);
  const switched = applyReaction(liked, 'fire');
  assert.deepEqual([switched.reactions, switched.my_reaction], [{ fire: 3 }, 'fire']);
  const removed = applyReaction(switched, 'fire');
  assert.deepEqual([removed.reactions, removed.my_reaction], [{ fire: 2 }, null]);
  assert.equal(totalReactions(removed), 2);
  assert.deepEqual(post.reactions, { fire: 2 });
});

test('relative times and feed paging behave', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  assert.equal(formatRelativeTime('2026-06-10T09:00:00Z', 'en', now), '3 hours ago');
  assert.equal(formatRelativeTime('2026-06-08T12:00:00Z', 'en', now), '2 days ago');
  assert.equal(formatRelativeTime('2026-06-10T12:00:10Z', 'en', now), 'now');
  const merged = mergeFeedPage([{ post_id: 'a' }, { post_id: 'b' }], [{ post_id: 'b' }, { post_id: 'c' }]);
  assert.deepEqual(merged.map((post) => post.post_id), ['a', 'b', 'c']);
});