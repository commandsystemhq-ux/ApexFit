import { callApi } from './apiClient.js';
import { requireSupabase } from './supabaseClient.js';
import { searchArgs } from './marketplaceUtils.js';

async function call(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// --- the coach's own profile and inbox
export const getMyMarketplaceProfile = () => call('get_my_marketplace_profile');

export const saveMyMarketplaceProfile = (payload) => call('save_my_marketplace_profile', {
  p_is_listed: payload.isListed,
  p_accepting_clients: payload.acceptingClients,
  p_headline: payload.headline,
  p_bio: payload.bio,
  p_specialties: payload.specialties,
  p_languages: payload.languages,
  p_certifications: payload.certifications,
  p_years_experience: payload.yearsExperience,
  p_city: payload.city,
  p_country_code: payload.countryCode,
  p_training_mode: payload.trainingMode,
  p_intro_video_url: payload.introVideoUrl,
});

export const listCoachContactRequests = (status = null) => call('list_coach_contact_requests', { p_status: status });
export const respondToContactRequest = (requestId, accept) => call('respond_contact_request', { p_request_id: requestId, p_accept: accept });
export const replyToReview = (reviewId, reply) => call('reply_to_coach_review', { p_review_id: reviewId, p_reply: reply });

// --- what a client sees
export const searchCoaches = (filters, page = 0) => call('search_marketplace_coaches', searchArgs(filters, page));
export const getMarketplaceCoach = (coachId) => call('get_marketplace_coach', { p_coach_id: coachId });
export const listCoachReviews = (coachId, { limit = 20, offset = 0 } = {}) => call('list_coach_reviews', { p_coach_id: coachId, p_limit: limit, p_offset: offset });
export const submitCoachReview = (coachId, rating, comment) => call('submit_coach_review', { p_coach_id: coachId, p_rating: rating, p_comment: comment });
export const reportMarketplace = (targetType, targetId, reason, details) => call('report_marketplace', {
  p_target_type: targetType, p_target_id: targetId, p_reason: reason, p_details: details || '',
});
export const sendContactRequest = (coachId, message) => call('send_contact_request', { p_coach_id: coachId, p_message: message });
export const cancelContactRequest = (requestId) => call('cancel_contact_request', { p_request_id: requestId });
export const listMyContactRequests = () => call('list_my_contact_requests');

// Web Push for a contact request. Best effort, like the other notifications: the in-app notification is already stored.
export function pushMarketplaceEvent(type, requestId) {
  return callApi('push', { body: { action: 'notify', type, id: requestId } }).catch(() => null);
}

// --- the platform owner
export const isPlatformAdmin = () => call('is_platform_admin');
export const adminListReports = (status = 'open', { limit = 30, offset = 0 } = {}) => call('admin_list_marketplace_reports', { p_status: status, p_limit: limit, p_offset: offset });
export const adminListCoaches = ({ query = null, state = 'all', limit = 30, offset = 0 } = {}) => call('admin_list_marketplace_coaches', {
  p_query: query || null, p_state: state, p_limit: limit, p_offset: offset,
});
export const adminListCoachReviews = (coachId) => call('admin_list_coach_reviews', { p_coach_id: coachId, p_limit: 50, p_offset: 0 });
export const adminSetCoachHidden = (coachId, hidden, reason, reportId = null) => call('admin_set_coach_hidden', {
  p_coach_id: coachId, p_hidden: hidden, p_reason: reason, p_report_id: reportId,
});
export const adminSetReviewHidden = (reviewId, hidden, reason, reportId = null) => call('admin_set_review_hidden', {
  p_review_id: reviewId, p_hidden: hidden, p_reason: reason, p_report_id: reportId,
});
export const adminResolveReport = (reportId, status, note) => call('admin_resolve_marketplace_report', { p_report_id: reportId, p_status: status, p_note: note });
