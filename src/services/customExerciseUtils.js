import { validateVideoLink } from './exerciseVideo.js';

// A coach's own exercises: what the form may contain and what is sent to save_custom_exercise.

export const CUSTOM_EXERCISE_LIMIT = 300;
export const MAX_EXERCISE_IMAGE_BYTES = 5 * 1024 * 1024;
export const EXERCISE_IMAGE_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });

export const EXERCISE_CATEGORIES = Object.freeze(['strength', 'cardio', 'mobility', 'plyometrics', 'warmup']);
export const EXERCISE_DIFFICULTIES = Object.freeze(['beginner', 'intermediate', 'advanced']);
export const EXERCISE_EQUIPMENT = Object.freeze(['barbell', 'dumbbell', 'kettlebell', 'cable', 'machine', 'resistance_band', 'bodyweight', 'medicine_ball', 'bench', 'smith_machine', 'trap_bar', 'landmine', 'plyometric_box', 'suspension_trainer', 'foam_roller', 'exercise_ball', 'other']);
export const EXERCISE_MUSCLES = Object.freeze(['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'core', 'lower_back', 'traps', 'neck', 'hip_flexors', 'adductors', 'abductors', 'full_body']);

const MAX_PRIMARY = 6;
const MAX_SECONDARY = 8;
const MAX_EQUIPMENT = 8;

export const isCustomExercise = (exercise) => Boolean(exercise?.owner_coach_id);

export function emptyCustomExerciseForm() {
  return {
    name: '', description: '', category: 'strength', difficulty: 'beginner',
    primaryMuscles: [], secondaryMuscles: [], equipment: [], videoUrl: '', imagePath: '',
  };
}

export function formFromExercise(exercise) {
  return {
    name: exercise?.name || '',
    description: exercise?.description || '',
    category: exercise?.category || 'strength',
    difficulty: exercise?.difficulty || 'beginner',
    primaryMuscles: [...(exercise?.primary_muscles || [])],
    secondaryMuscles: [...(exercise?.secondary_muscles || [])],
    equipment: [...(exercise?.equipment || [])],
    videoUrl: exercise?.demo_video_url || '',
    imagePath: exercise?.image_path || '',
  };
}

// Adds the value to the list, or removes it when it is already there.
export function toggleOption(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function validateExerciseImage(file) {
  if (!file || !EXERCISE_IMAGE_TYPES[file.type]) return 'ceErr_imageType';
  if (file.size > MAX_EXERCISE_IMAGE_BYTES) return 'ceErr_imageSize';
  return null;
}

// The photo lives in the coach's own folder; the database refuses any other path.
export function exerciseImagePath(coachId, file, uniqueId) {
  return `${coachId}/${uniqueId}.${EXERCISE_IMAGE_TYPES[file.type]}`;
}

// Checks the form. `errors` maps a field to a translation key; `payload` is the argument list of save_custom_exercise.
export function validateCustomExercise(form) {
  const errors = {};
  const name = String(form.name ?? '').trim();
  const description = String(form.description ?? '').trim();
  if (!name || name.length > 160) errors.name = 'ceErr_name';
  if (description.length > 2000) errors.description = 'ceErr_description';
  if (!EXERCISE_CATEGORIES.includes(form.category)) errors.category = 'ceErr_category';
  if (!EXERCISE_DIFFICULTIES.includes(form.difficulty)) errors.difficulty = 'ceErr_difficulty';

  const primary = form.primaryMuscles.filter((value) => EXERCISE_MUSCLES.includes(value));
  const secondary = form.secondaryMuscles.filter((value) => EXERCISE_MUSCLES.includes(value) && !primary.includes(value));
  const equipment = form.equipment.filter((value) => EXERCISE_EQUIPMENT.includes(value));
  if (primary.length === 0) errors.primaryMuscles = 'ceErr_muscle';
  else if (primary.length > MAX_PRIMARY) errors.primaryMuscles = 'ceErr_tooMany';
  if (secondary.length > MAX_SECONDARY) errors.secondaryMuscles = 'ceErr_tooMany';
  if (equipment.length > MAX_EQUIPMENT) errors.equipment = 'ceErr_tooMany';

  const video = validateVideoLink(form.videoUrl);
  if (!video.ok) errors.videoUrl = video.error;

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    payload: {
      p_name: name,
      p_description: description,
      p_category: form.category,
      p_primary_muscles: primary,
      p_secondary_muscles: secondary,
      p_equipment: equipment,
      p_difficulty: form.difficulty,
      p_video_url: video.ok ? video.value : '',
      p_image_path: form.imagePath || '',
    },
  };
}
