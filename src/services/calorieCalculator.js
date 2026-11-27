// Energy needs and macros. Pure functions (no network, no React); weights are in kg and heights in cm.
//
// BMR (basal metabolic rate, kcal/day):
//   Mifflin-St Jeor (1990)        10 W + 6.25 H - 5 A + 5 (men) / - 161 (women)
//   Harris-Benedict, revised 1984  men 88.362 + 13.397 W + 4.799 H - 5.677 A
//                                  women 447.593 + 9.247 W + 3.098 H - 4.330 A
//   Katch-McArdle                  370 + 21.6 x lean body mass, where lean body mass = W x (1 - body fat / 100)
// TDEE = BMR x activity factor. The daily target is the TDEE moved by a percentage that depends on the goal.

export const FORMULAS = Object.freeze(['mifflin', 'harris', 'katch']);
export const GOALS = Object.freeze(['cut', 'maintain', 'bulk']);
export const MACRO_SPLITS = Object.freeze(['goal', 'balanced', 'high_protein', 'low_carb', 'custom']);

export const ACTIVITY_FACTORS = Object.freeze({ sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 });
export const ACTIVITY_LEVELS = Object.freeze(Object.keys(ACTIVITY_FACTORS));

export const DEFAULT_ADJUSTMENT = Object.freeze({ cut: -20, maintain: 0, bulk: 10 });
export const ADJUSTMENT_LIMITS = Object.freeze({ min: -30, max: 25 });
// Never suggest less than this much energy a day.
export const MIN_CALORIES = Object.freeze({ male: 1500, female: 1200 });

const PROTEIN_PER_KG = Object.freeze({ cut: 2.2, maintain: 1.8, bulk: 2.0 });
const PERCENT_SPLITS = Object.freeze({
  balanced: { protein: 30, carbs: 40, fat: 30 },
  high_protein: { protein: 40, carbs: 35, fat: 25 },
  low_carb: { protein: 35, carbs: 25, fat: 40 },
});

const LIMITS = Object.freeze({ age: [10, 100], weightKg: [20, 400], heightCm: [100, 250], bodyFatPct: [3, 60] });

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

// "72,5" and Arabic-Indic digits are accepted; anything that is not a finite number gives null.
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '')
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(',', '.')
    .trim();
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

// Whole years on `today` for a 'YYYY-MM-DD' birth date; null when the date is not usable.
export function ageFromBirthDate(birthDate, today = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthDate ?? ''));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let age = today.getFullYear() - year;
  if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) age -= 1;
  return age >= 0 ? age : null;
}

export function leanBodyMass(weightKg, bodyFatPct) {
  return weightKg * (1 - bodyFatPct / 100);
}

// BMR for one formula, or null when the formula cannot be used with the data (Katch-McArdle without body fat).
export function computeBmr(formula, { sex, weightKg, heightCm, age, bodyFatPct }) {
  if (formula === 'mifflin') return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
  if (formula === 'harris') {
    return sex === 'male'
      ? 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * age
      : 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * age;
  }
  if (formula === 'katch') {
    if (bodyFatPct === null || bodyFatPct === undefined) return null;
    return 370 + 21.6 * leanBodyMass(weightKg, bodyFatPct);
  }
  throw new RangeError(`Unknown formula: ${formula}`);
}

export const computeTdee = (bmr, activity) => bmr * ACTIVITY_FACTORS[activity];

// The daily target for a goal. `adjustmentPct` replaces the default percentage for the goal (e.g. -15 for a gentler cut).
export function targetCalories(tdee, goal, { adjustmentPct = DEFAULT_ADJUSTMENT[goal], sex = 'male' } = {}) {
  const pct = Math.min(ADJUSTMENT_LIMITS.max, Math.max(ADJUSTMENT_LIMITS.min, adjustmentPct));
  const wanted = Math.round(tdee * (1 + pct / 100));
  const min = MIN_CALORIES[sex] ?? MIN_CALORIES.female;
  return wanted < min ? { calories: min, floored: true, min, adjustmentPct: pct } : { calories: wanted, floored: false, min, adjustmentPct: pct };
}

// Splits calories into grams of protein, carbs and fat (4, 4 and 9 kcal per gram).
//   goal      protein by body weight for the goal, fat about 25% of calories (not under 0.6 g/kg), carbs the rest
//   balanced / high_protein / low_carb   fixed percentages
//   custom    the percentages given in `custom` ({ protein, carbs, fat }, summing to 100)
export function computeMacros({ calories, weightKg, goal = 'maintain', split = 'goal', custom = null }) {
  let proteinG;
  let fatG;
  let carbsG;
  if (split === 'goal') {
    proteinG = Math.min(PROTEIN_PER_KG[goal] * weightKg, (calories * 0.4) / 4);
    fatG = Math.max((calories * 0.25) / 9, 0.6 * weightKg);
    fatG = Math.min(fatG, Math.max(0, (calories - proteinG * 4) * 0.6) / 9);
    carbsG = Math.max(0, (calories - proteinG * 4 - fatG * 9) / 4);
  } else {
    const percents = split === 'custom' ? custom : PERCENT_SPLITS[split];
    if (!percents) throw new RangeError(`Unknown macro split: ${split}`);
    proteinG = (calories * percents.protein) / 100 / 4;
    carbsG = (calories * percents.carbs) / 100 / 4;
    fatG = (calories * percents.fat) / 100 / 9;
  }
  const grams = { protein: Math.round(proteinG), carbs: Math.round(carbsG), fat: Math.round(fatG) };
  const kcal = { protein: grams.protein * 4, carbs: grams.carbs * 4, fat: grams.fat * 9 };
  const total = kcal.protein + kcal.carbs + kcal.fat || 1;
  return {
    grams,
    percent: { protein: round((kcal.protein / total) * 100), carbs: round((kcal.carbs / total) * 100), fat: round((kcal.fat / total) * 100) },
    kcalFromMacros: total,
  };
}

// Checks the form (values are strings or numbers). `errors` maps a field to a translation key; `values` are the numbers.
export function validateCalculatorInput(form) {
  const errors = {};
  const values = {
    sex: form.sex,
    age: parseNumber(form.age),
    heightCm: parseNumber(form.heightCm),
    weightKg: parseNumber(form.weightKg),
    bodyFatPct: String(form.bodyFatPct ?? '').trim() === '' ? null : parseNumber(form.bodyFatPct),
    activity: form.activity,
    goal: form.goal,
    formula: form.formula,
    split: form.split || 'goal',
    adjustmentPct: parseNumber(form.adjustmentPct),
  };
  if (values.sex !== 'male' && values.sex !== 'female') errors.sex = 'ccErr_sex';
  const inRange = (value, [min, max]) => value !== null && value >= min && value <= max;
  if (!inRange(values.age, LIMITS.age)) errors.age = 'ccErr_age';
  if (!inRange(values.heightCm, LIMITS.heightCm)) errors.heightCm = 'ccErr_height';
  if (!inRange(values.weightKg, LIMITS.weightKg)) errors.weightKg = 'ccErr_weight';
  if (values.bodyFatPct !== null && !inRange(values.bodyFatPct, LIMITS.bodyFatPct)) errors.bodyFatPct = 'ccErr_bodyFat';
  if (!ACTIVITY_LEVELS.includes(values.activity)) errors.activity = 'ccErr_activity';
  if (!GOALS.includes(values.goal)) errors.goal = 'ccErr_goal';
  if (!FORMULAS.includes(values.formula)) errors.formula = 'ccErr_formula';
  else if (values.formula === 'katch' && values.bodyFatPct === null && !errors.bodyFatPct) errors.bodyFatPct = 'ccErr_katchNeedsFat';
  if (!MACRO_SPLITS.includes(values.split)) errors.split = 'ccErr_split';
  if (values.adjustmentPct === null) values.adjustmentPct = DEFAULT_ADJUSTMENT[values.goal] ?? 0;
  if (values.adjustmentPct < ADJUSTMENT_LIMITS.min || values.adjustmentPct > ADJUSTMENT_LIMITS.max) errors.adjustmentPct = 'ccErr_adjustment';

  if (values.split === 'custom') {
    const custom = { protein: parseNumber(form.customProtein), carbs: parseNumber(form.customCarbs), fat: parseNumber(form.customFat) };
    const sum = (custom.protein ?? NaN) + (custom.carbs ?? NaN) + (custom.fat ?? NaN);
    if (Object.values(custom).some((value) => value === null || value < 0) || Math.abs(sum - 100) > 0.5) errors.split = 'ccErr_customSum';
    values.custom = custom;
  }
  return { ok: Object.keys(errors).length === 0, errors, values };
}

// The full answer for valid input: every BMR that can be computed, the chosen one, TDEE, the target and the macros.
export function calculate(values) {
  const bmrs = {};
  for (const formula of FORMULAS) {
    const value = computeBmr(formula, values);
    bmrs[formula] = value === null ? null : Math.round(value);
  }
  const bmr = computeBmr(values.formula, values);
  if (bmr === null) throw new RangeError('The chosen formula needs the body fat percentage.');
  const tdee = computeTdee(bmr, values.activity);
  const target = targetCalories(tdee, values.goal, { adjustmentPct: values.adjustmentPct, sex: values.sex });
  const macros = computeMacros({ calories: target.calories, weightKg: values.weightKg, goal: values.goal, split: values.split, custom: values.custom });
  return {
    bmrs,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calories: target.calories,
    floored: target.floored,
    minCalories: target.min,
    adjustmentPct: target.adjustmentPct,
    macros,
    // The shape set_client_nutrition_targets takes.
    payload: { calories: target.calories, protein: macros.grams.protein, carbs: macros.grams.carbs, fats: macros.grams.fat },
  };
}

// The goal suggested by what the client said at intake.
export function goalFromIntake(primaryGoal) {
  if (primaryGoal === 'fat_loss') return 'cut';
  if (primaryGoal === 'muscle_gain') return 'bulk';
  return 'maintain';
}
