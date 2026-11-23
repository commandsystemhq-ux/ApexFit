import { callApi } from './apiClient.js';

// Jack's work for the coach. The server checks that the caller is an active coach, runs the AI when one is configured
// and the built-in rules otherwise; `source` in every answer says which one wrote it ('ai' or 'rules').
const assistant = (action, input) => callApi('jack-assistant', { body: { action, ...input } });

// Builds a full training plan and saves it as a real program (it shows in Program templates and in "Plans created").
export const generateTrainingPlan = (input) => assistant('generate_plan', input);

// What the client's real numbers say, with concrete changes to suggest.
export const analyzeClient = ({ clientId, days = 30, language = 'en' }) => assistant('analyze_client', { client_id: clientId, days, language });

// A draft progress report (Arabic or English) for the coach to review, edit and send.
export const draftProgressReport = ({ clientId, days = 30, language = 'ar' }) => assistant('progress_report', { client_id: clientId, days, language });