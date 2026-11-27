import { getCurrentUserId } from './clientIdentity.js';
import { exerciseImagePath, validateExerciseImage } from './customExerciseUtils.js';
import { requireSupabase } from './supabaseClient.js';

const BUCKET = 'apexfit-exercise-images';
const SIGNED_URL_SECONDS = 3600;

// Creates a custom exercise, or updates it when `exerciseId` is given. Returns the exercise id.
export async function saveCustomExercise(payload, exerciseId = null) {
  const { data, error } = await requireSupabase().rpc('save_custom_exercise', { ...payload, p_exercise_id: exerciseId });
  if (error) throw error;
  return data;
}

// Deletes the exercise; the photo file is removed afterwards (a leftover file never blocks the deletion).
export async function deleteCustomExercise(exerciseId) {
  const client = requireSupabase();
  const { data, error } = await client.rpc('delete_custom_exercise', { p_exercise_id: exerciseId });
  if (error) throw error;
  if (data?.image_path) await removeExerciseImage(data.image_path);
  return data;
}

// Uploads a photo to the coach's own folder of the private bucket and returns its path.
export async function uploadExerciseImage(file) {
  const problem = validateExerciseImage(file);
  if (problem) throw new TypeError(problem);
  const client = requireSupabase();
  const path = exerciseImagePath(await getCurrentUserId(client), file, crypto.randomUUID());
  const { error } = await client.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: '3600', upsert: false });
  if (error) throw error;
  return path;
}

export async function removeExerciseImage(path) {
  if (!path) return;
  try {
    await requireSupabase().storage.from(BUCKET).remove([path]);
  } catch {
    // The file may already be gone; nothing depends on it.
  }
}

// A custom exercise's photo is private: it is shown through a temporary link placed in thumbnail_url. Anything that
// goes wrong leaves the exercise without a picture rather than failing the screen.
export async function signExerciseImages(exercises) {
  const paths = [...new Set(exercises.map((exercise) => exercise?.image_path).filter(Boolean))];
  if (!paths.length) return exercises;
  try {
    const { data, error } = await requireSupabase().storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
    if (error) return exercises;
    const urls = new Map((data || []).filter((item) => item.signedUrl).map((item) => [item.path, item.signedUrl]));
    return exercises.map((exercise) => (exercise?.image_path && urls.has(exercise.image_path)
      ? { ...exercise, thumbnail_url: urls.get(exercise.image_path) }
      : exercise));
  } catch {
    return exercises;
  }
}
