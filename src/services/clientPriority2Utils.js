export const INTAKE_GOALS = ['fat_loss', 'muscle_gain', 'strength', 'endurance', 'general_fitness'];
export const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const EQUIPMENT_ACCESS = ['full_gym', 'home_gym', 'bodyweight_only'];
// Every meal category the database accepts, in the order a day shows them. The Ramadan ones (before iftar, iftar,
// suhoor) are offered only when Ramadan meals are switched on, or when the day or plan already uses them.
export const BASE_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
export const RAMADAN_MEAL_TYPES = ['pre_iftar', 'iftar', 'suhoor'];
export const MEAL_TYPES = ['breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor'];
export const MEAL_LABELS = Object.freeze({
  breakfast: 'mealBreakfast', lunch: 'mealLunch', pre_iftar: 'mealPreIftar', iftar: 'mealIftar', dinner: 'mealDinner', snack: 'mealSnack', suhoor: 'mealSuhoor',
});

// The meals to offer: the four everyday ones, plus the Ramadan ones when ramadan is on, plus any Ramadan meal in used.
export function mealTypesFor(ramadan, used = []) {
  const inUse = new Set(used);
  return MEAL_TYPES.filter((meal) => BASE_MEAL_TYPES.includes(meal) || ramadan || inUse.has(meal));
}

function isBlank(value) {
  return value === '' || value === null || value === undefined;
}

function optionalNumber(value, { min, max, label }) {
  if (isBlank(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function boundedText(value, maxLength, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > maxLength) throw new RangeError(`${label} cannot exceed ${maxLength} characters.`);
  return text;
}

function requireOption(value, options, label) {
  if (!options.includes(value)) throw new TypeError(`Choose a valid ${label}.`);
  return value;
}

export function normalizeIntakeForm(form) {
  const trainingDays = Number(form.training_days_per_week);
  if (!Number.isInteger(trainingDays) || trainingDays < 1 || trainingDays > 7) {
    throw new RangeError('Training days per week must be a whole number between 1 and 7.');
  }

  return {
    primary_goal: requireOption(form.primary_goal, INTAKE_GOALS, 'goal'),
    experience_level: requireOption(form.experience_level, EXPERIENCE_LEVELS, 'experience level'),
    training_days_per_week: trainingDays,
    equipment_access: requireOption(form.equipment_access, EQUIPMENT_ACCESS, 'equipment option'),
    height_cm: optionalNumber(form.height_cm, { min: 50, max: 275, label: 'Height' }),
    injuries: boundedText(form.injuries, 1000, 'Injuries'),
    medical_conditions: boundedText(form.medical_conditions, 1000, 'Medical conditions'),
    dietary_preferences: boundedText(form.dietary_preferences, 500, 'Dietary preferences'),
    additional_notes: boundedText(form.additional_notes, 1000, 'Additional notes'),
  };
}

export function normalizeFoodEntry(entry) {
  const foodName = boundedText(entry.food_name, 160, 'Food name');
  if (!foodName) throw new TypeError('Enter the food or meal name.');
  if (isBlank(entry.calories)) throw new TypeError('Enter the calories for this food.');

  return {
    meal_type: requireOption(entry.meal_type, MEAL_TYPES, 'meal'),
    food_name: foodName,
    ingredients: boundedText(entry.ingredients, 1000, 'Ingredients'),
    calories: optionalNumber(entry.calories, { min: 0, max: 10000, label: 'Calories' }),
    protein_g: optionalNumber(entry.protein_g, { min: 0, max: 1000, label: 'Protein' }),
    carbs_g: optionalNumber(entry.carbs_g, { min: 0, max: 1000, label: 'Carbs' }),
    fat_g: optionalNumber(entry.fat_g, { min: 0, max: 1000, label: 'Fat' }),
  };
}

export function summarizeFoodDay(entries) {
  const round = (value) => Math.round(value * 10) / 10;
  const totals = entries.reduce((sum, entry) => ({
    calories: sum.calories + Number(entry.calories || 0),
    protein_g: sum.protein_g + Number(entry.protein_g || 0),
    carbs_g: sum.carbs_g + Number(entry.carbs_g || 0),
    fat_g: sum.fat_g + Number(entry.fat_g || 0),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

  return {
    calories: round(totals.calories),
    protein_g: round(totals.protein_g),
    carbs_g: round(totals.carbs_g),
    fat_g: round(totals.fat_g),
    count: entries.length,
  };
}

export function groupOneRepMaxHistory(rows) {
  const byExercise = new Map();
  for (const row of rows) {
    const estimate = Number(row.estimated_one_rep_max);
    if (!Number.isFinite(estimate)) continue;
    if (!byExercise.has(row.exercise_id)) {
      byExercise.set(row.exercise_id, { exerciseId: row.exercise_id, name: row.exercise_name, records: [] });
    }
    byExercise.get(row.exercise_id).records.push({
      workout_date: row.workout_date,
      estimated_one_rep_max: estimate,
      top_weight_kg: Number(row.top_weight_kg),
      top_reps: Number(row.top_reps),
    });
  }

  return [...byExercise.values()]
    .map((exercise) => {
      const records = exercise.records.sort((left, right) => left.workout_date.localeCompare(right.workout_date));
      const best = records.reduce((top, record) => (
        record.estimated_one_rep_max > top.estimated_one_rep_max ? record : top
      ), records[0]);
      const latest = records[records.length - 1];
      return {
        ...exercise,
        records,
        best,
        latest,
        change: Math.round((latest.estimated_one_rep_max - records[0].estimated_one_rep_max) * 10) / 10,
      };
    })
    .sort((left, right) => (
      right.latest.workout_date.localeCompare(left.latest.workout_date) || left.name.localeCompare(right.name)
    ));
}

export function countProgramContents(program) {
  const days = program.days || [];
  return {
    dayCount: days.length,
    exerciseCount: days.reduce((total, day) => total + (day.exercises?.length || 0), 0),
  };
}
