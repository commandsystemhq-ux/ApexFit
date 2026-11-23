import { searchTokens } from './exerciseI18n.js';
import { listVideoOverrides } from './exerciseVideoService.js';
import { mergeVideoOverrides } from './exerciseVideo.js';
import { requireSupabase } from './supabaseClient.js';

const EXERCISE_FIELDS = 'id,slug,name,name_i18n,category,primary_muscles,equipment,difficulty,instructions,instructions_i18n,demo_video_url,thumbnail_url,animation_url,image_frames';

export async function searchExercises({
  search = '',
  category = '',
  equipment = '',
  muscle = '',
  difficulty = '',
  page = 1,
  pageSize = 24,
} = {}) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('Exercise page must be a positive integer.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('Exercise page size must be between 1 and 100.');
  }

  const client = requireSupabase();
  let request = client
    .from('exercises')
    .select(EXERCISE_FIELDS, { count: 'exact' })
    .eq('is_published', true);

  // Every word must appear in the English name or in a translated name (Arabic, German, French or Spanish).
  for (const token of searchTokens(search)) request = request.ilike('search_text', `%${token.replace(/[\\%_*]/g, '\\$&')}%`);
  if (category) request = request.eq('category', category);
  if (equipment) request = request.contains('equipment', [equipment]);
  if (muscle) request = request.contains('primary_muscles', [muscle]);
  if (difficulty) request = request.eq('difficulty', difficulty);

  const { data, error, count } = await request
    .order('name', { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;

  const exercises = data || [];
  return { exercises: mergeVideoOverrides(exercises, await listVideoOverrides(exercises.map((exercise) => exercise.id))), total: count || 0 };
}
