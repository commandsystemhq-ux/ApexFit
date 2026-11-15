import { requireSupabase } from './supabaseClient.js';

const EXERCISE_FIELDS = 'id,slug,name,category,primary_muscles,equipment,difficulty,instructions,demo_video_url,thumbnail_url';

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
  const term = search.trim().slice(0, 100).replace(/[\\%_*]/g, '\\$&');

  if (term) request = request.ilike('name', `%${term}%`);
  if (category) request = request.eq('category', category);
  if (equipment) request = request.contains('equipment', [equipment]);
  if (muscle) request = request.contains('primary_muscles', [muscle]);
  if (difficulty) request = request.eq('difficulty', difficulty);

  const { data, error, count } = await request
    .order('name', { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;

  return { exercises: data || [], total: count || 0 };
}
