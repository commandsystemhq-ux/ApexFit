import { requireSupabase } from './supabaseClient.js';
import {
  normalizeComment,
  normalizeDisplayName,
  normalizePostBody,
} from './communityUtils.js';

export const FEED_PAGE_SIZE = 20;

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export async function getMyCommunityProfile() {
  const { data, error } = await requireSupabase()
    .from('community_profiles')
    .select('display_name,leaderboard_opt_in')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export const joinCommunity = ({ displayName, leaderboardOptIn }) => rpc('join_community', {
  p_display_name: normalizeDisplayName(displayName),
  p_leaderboard_opt_in: Boolean(leaderboardOptIn),
});

export const listFeed = (coachId, before = null) => rpc('list_community_feed', {
  p_coach_id: coachId,
  p_limit: FEED_PAGE_SIZE,
  p_before: before,
});

export const createPost = (coachId, { kind = 'update', body = '', achievementCode = null }) => rpc('create_community_post', {
  p_coach_id: coachId,
  p_kind: kind,
  p_body: normalizePostBody(body, { allowEmpty: kind === 'achievement', maxLength: kind === 'achievement' ? 500 : 1000 }),
  p_achievement_code: achievementCode,
});

export const deletePost = (postId) => rpc('delete_community_post', { p_post_id: postId });
export const listComments = (postId) => rpc('list_post_comments', { p_post_id: postId });
export const addComment = (postId, body) => rpc('add_post_comment', { p_post_id: postId, p_body: normalizeComment(body) });
export const deleteComment = (commentId) => rpc('delete_post_comment', { p_comment_id: commentId });
export const setReaction = (postId, reaction) => rpc('set_post_reaction', { p_post_id: postId, p_reaction: reaction });
export const getMyGamification = () => rpc('get_my_gamification');
export const getLeaderboard = (coachId, period) => rpc('get_leaderboard', { p_coach_id: coachId, p_period: period });
