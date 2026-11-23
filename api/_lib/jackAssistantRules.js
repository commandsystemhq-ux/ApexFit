// Jack's rule-based mode. It uses only real data (the exercise library, the client's numbers) and fixed, explainable
// rules, so plan generation, client analysis and progress reports keep working when no AI key is configured and when
// the AI provider fails.

export const GOALS = ['fat_loss', 'muscle_gain', 'strength', 'endurance', 'general_fitness'];
export const LEVELS = ['beginner', 'intermediate', 'advanced'];
export const ENVIRONMENTS = ['gym', 'home', 'bodyweight'];
export const REPORT_LOCALES = ['ar', 'en'];

const EQUIPMENT_BY_ENVIRONMENT = {
  gym: null,
  home: ['bodyweight', 'dumbbell', 'resistance_band', 'kettlebell', 'exercise_ball', 'medicine_ball', 'other'],
  bodyweight: ['bodyweight'],
};

// Equipment that makes a movement a good "main" lift comes first, so a gym plan starts with barbells and a home plan
// with dumbbells.
const EQUIPMENT_RANK = {
  gym: { barbell: 5, dumbbell: 4, machine: 3, cable: 3, kettlebell: 2, bodyweight: 2, other: 1 },
  home: { dumbbell: 5, kettlebell: 4, resistance_band: 3, bodyweight: 3, other: 1 },
  bodyweight: { bodyweight: 3 },
};

const SLOTS = {
  full: ['quadriceps', 'chest', 'back', 'shoulders', 'hamstrings', 'core'],
  fullB: ['glutes', 'back', 'chest', 'quadriceps', 'shoulders', 'core'],
  fullC: ['hamstrings', 'shoulders', 'back', 'chest', 'quadriceps', 'core'],
  upper: ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'core'],
  lower: ['quadriceps', 'hamstrings', 'glutes', 'calves', 'core'],
  push: ['chest', 'shoulders', 'chest', 'triceps', 'triceps', 'core'],
  pull: ['back', 'back', 'biceps', 'traps', 'biceps', 'core'],
  legs: ['quadriceps', 'hamstrings', 'glutes', 'quadriceps', 'calves', 'core'],
  mobility: ['core', 'hamstrings', 'shoulders', 'lower_back'],
};

const SPLITS = {
  1: ['full'],
  2: ['full', 'fullB'],
  3: ['full', 'fullB', 'fullC'],
  4: ['upper', 'lower', 'upper', 'lower'],
  5: ['push', 'pull', 'legs', 'upper', 'lower'],
  6: ['push', 'pull', 'legs', 'push', 'pull', 'legs'],
  7: ['push', 'pull', 'legs', 'push', 'pull', 'legs', 'mobility'],
};

const DAY_NAMES = {
  en: { full: 'Full body', fullB: 'Full body', fullC: 'Full body', upper: 'Upper body', lower: 'Lower body', push: 'Push', pull: 'Pull', legs: 'Legs', mobility: 'Mobility and recovery' },
  ar: { full: 'الجسم كاملًا', fullB: 'الجسم كاملًا', fullC: 'الجسم كاملًا', upper: 'الجزء العلوي', lower: 'الجزء السفلي', push: 'دفع', pull: 'سحب', legs: 'الأرجل', mobility: 'مرونة واستشفاء' },
};
const DAY_WORD = { en: 'Day', ar: 'اليوم' };
const GOAL_NAMES = {
  en: { fat_loss: 'Fat loss', muscle_gain: 'Muscle gain', strength: 'Strength', endurance: 'Endurance', general_fitness: 'General fitness' },
  ar: { fat_loss: 'حرق الدهون', muscle_gain: 'بناء العضلات', strength: 'القوة', endurance: 'التحمل', general_fitness: 'اللياقة العامة' },
};
const LEVEL_NAMES = { en: { beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' }, ar: { beginner: 'مبتدئ', intermediate: 'متوسط', advanced: 'متقدم' } };
const ENV_NAMES = { en: { gym: 'full gym', home: 'home equipment', bodyweight: 'bodyweight only' }, ar: { gym: 'صالة رياضية كاملة', home: 'أدوات منزلية', bodyweight: 'وزن الجسم فقط' } };

// What the person wrote under injuries or limitations, turned into movements to leave out.
const LIMITATION_RULES = [
  { test: /knee|ركب/i, avoid: /jump|plyo|lunge|box|burpee|sprint|hop|قفز/i, note: { en: 'Knee: jumping and lunging movements were left out.', ar: 'الركبة: تم استبعاد حركات القفز والاندفاع.' } },
  { test: /shoulder|كتف|أكتاف/i, avoid: /overhead|military|snatch|clean|behind|dip|upright|jerk/i, note: { en: 'Shoulder: overhead and behind-the-neck movements were left out.', ar: 'الكتف: تم استبعاد حركات الضغط فوق الرأس وخلف الرقبة.' } },
  { test: /back|spine|disc|ظهر|فقرات|ديسك/i, avoid: /deadlift|good morning|bent[- ]over|clean|snatch|hyperextension|jefferson/i, note: { en: 'Back: heavy hinging and loaded spinal movements were left out.', ar: 'الظهر: تم استبعاد حركات الرفعة الميتة والانحناء بأحمال.' } },
  { test: /wrist|elbow|معصم|كوع|مرفق/i, avoid: /skull|wrist curl|push-up on|handstand|clean/i, note: { en: 'Wrist or elbow: wrist-loaded movements were left out.', ar: 'المعصم أو الكوع: تم استبعاد الحركات التي تضغط على المعصم.' } },
];

export function limitationFilter(text) {
  const written = String(text || '');
  const applied = LIMITATION_RULES.filter((rule) => rule.test.test(written));
  return { avoid: applied.map((rule) => rule.avoid), notes: applied.map((rule) => rule.note) };
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function levelAllows(level, difficulty) {
  if (level === 'beginner') return difficulty === 'beginner';
  if (level === 'intermediate') return difficulty !== 'advanced';
  return true;
}

// How a goal loads an exercise: sets, repetitions and rest. The first slot of a day is the main lift.
function prescription(goal, level, isMain) {
  const base = {
    strength: isMain ? { sets: 5, reps: '5', rest: 150 } : { sets: 3, reps: '8', rest: 90 },
    muscle_gain: isMain ? { sets: 4, reps: '8-12', rest: 90 } : { sets: 3, reps: '10-15', rest: 60 },
    fat_loss: { sets: 3, reps: '12-15', rest: 45 },
    endurance: { sets: 3, reps: '15-20', rest: 30 },
    general_fitness: { sets: 3, reps: '10-12', rest: 60 },
  }[goal] || { sets: 3, reps: '10-12', rest: 60 };
  const sets = level === 'beginner' ? Math.min(base.sets, 3) : level === 'advanced' ? Math.min(base.sets + (isMain ? 0 : 1), 6) : base.sets;
  return { sets, reps: base.reps, rest_seconds: base.rest };
}

export function normalizeRequest(body = {}) {
  const days = Math.round(Number(body.days));
  return {
    days: Number.isInteger(days) && days >= 1 && days <= 7 ? days : 3,
    goal: GOALS.includes(body.goal) ? body.goal : 'general_fitness',
    level: LEVELS.includes(body.level) ? body.level : 'beginner',
    environment: ENVIRONMENTS.includes(body.environment) ? body.environment : 'gym',
    limitations: String(body.limitations || '').slice(0, 500),
    notes: String(body.notes || '').slice(0, 500),
    language: REPORT_LOCALES.includes(body.language) ? body.language : (body.locale === 'ar' ? 'ar' : 'en'),
  };
}

// The exercises a request can use: published strength movements with the right equipment and difficulty, minus what
// the limitations rule out.
export function usableExercises(catalog, request) {
  const equipment = EQUIPMENT_BY_ENVIRONMENT[request.environment];
  const { avoid } = limitationFilter(request.limitations);
  return (catalog || []).filter((exercise) => (
    exercise.category === 'strength'
    && levelAllows(request.level, exercise.difficulty)
    && (!equipment || (exercise.equipment || []).length === 0 || exercise.equipment.some((item) => equipment.includes(item)))
    && !avoid.some((pattern) => pattern.test(exercise.name))
  ));
}

function rank(exercise, environment) {
  const table = EQUIPMENT_RANK[environment] || EQUIPMENT_RANK.gym;
  return Math.max(0, ...(exercise.equipment || []).map((item) => table[item] || 0));
}

// The plan: one entry per training day, every exercise taken from the library.
export function buildRulePlan(catalog, input) {
  const request = normalizeRequest(input);
  const language = request.language;
  const pool = usableExercises(catalog, request);
  const split = SPLITS[request.days];
  const used = new Set();
  const days = split.map((kind, dayIndex) => {
    const slots = SLOTS[kind];
    const perDay = request.level === 'beginner' ? Math.min(slots.length, 5) : slots.length;
    const exercises = [];
    const today = new Set();
    slots.slice(0, perDay).forEach((muscle, slotIndex) => {
      const candidates = pool
        .filter((exercise) => (exercise.primary_muscles || []).includes(muscle) && !today.has(exercise.id))
        .sort((a, b) => (used.has(a.id) - used.has(b.id)) || (rank(b, request.environment) - rank(a, request.environment)) || (hash(`${dayIndex}:${muscle}:${a.slug}`) - hash(`${dayIndex}:${muscle}:${b.slug}`)));
      const pick = candidates[0];
      if (!pick) return;
      today.add(pick.id);
      used.add(pick.id);
      exercises.push({ exercise_id: pick.id, ...prescription(request.goal, request.level, slotIndex === 0), notes: '' });
    });
    return { name: `${DAY_WORD[language]} ${dayIndex + 1} - ${DAY_NAMES[language][kind]}`, exercises };
  }).filter((day) => day.exercises.length > 0);

  const limits = limitationFilter(request.limitations);
  const warnings = limits.notes.map((note) => note[language]);
  const description = [
    language === 'ar'
      ? `خطة ${request.days} أيام في الأسبوع لهدف ${GOAL_NAMES.ar[request.goal]}، لمستوى ${LEVEL_NAMES.ar[request.level]}، باستخدام ${ENV_NAMES.ar[request.environment]}.`
      : `A ${request.days}-day weekly plan for ${GOAL_NAMES.en[request.goal].toLowerCase()}, for a ${LEVEL_NAMES.en[request.level]} lifter, using ${ENV_NAMES.en[request.environment]}.`,
    ...warnings,
    request.notes,
  ].filter(Boolean).join('\n');

  return {
    title: language === 'ar' ? `${GOAL_NAMES.ar[request.goal]} - ${request.days} أيام` : `${GOAL_NAMES.en[request.goal]} - ${request.days} days`,
    description: description.slice(0, 2000),
    days,
    warnings,
    request,
  };
}

// ------------------------------------------------------------------------------------------------- analysis

const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const rounded = (value, digits = 1) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

const TEXT = {
  en: {
    low: (v) => `Training consistency is low: ${v.done} workouts in ${v.days} days against about ${v.expected} planned. Ask what gets in the way and consider fewer, shorter sessions for now.`,
    ok: (v) => `Training consistency is good: ${v.done} workouts in ${v.days} days (about ${v.expected} planned).`,
    none: () => 'No workouts were logged in this period. Contact the client before changing the plan.',
    weightLoss: (v) => `Weight changed by ${v.change} kg (${v.start} to ${v.end} kg), in line with a fat-loss goal.`,
    weightWrong: (v) => `Weight changed by ${v.change} kg (${v.start} to ${v.end} kg), the opposite direction of the goal. Review nutrition first.`,
    weightGain: (v) => `Weight changed by +${v.change} kg (${v.start} to ${v.end} kg), in line with a muscle-gain goal.`,
    weightFlat: (v) => `Weight is almost unchanged (${v.change} kg). If the goal is body change, adjust calories by 5-10%.`,
    foodLow: (v) => `Food was logged on only ${v.foodDays} of ${v.days} days, so the nutrition picture is incomplete. Ask for daily logging.`,
    calories: (v) => `Average intake is ${v.avg} kcal against a goal of ${v.goal} kcal (${v.diff}%). Adjust portions or the goal.`,
    sleepLow: (v) => `Average sleep is ${v.avg} hours, below 7. Poor recovery limits progress: set a sleep task.`,
    checkinLow: (v) => `Weekly check-ins show workout adherence of ${v.avg}/10. Talk about what made weeks hard.`,
    energyLow: (v) => `Energy was rated ${v.avg}/5 in the last check-ins. Consider a lighter week (deload).`,
    noCheckins: () => 'No weekly check-ins were received. Remind the client to send one.',
    strengthUp: (v) => `Strength is rising: ${v.list}.`,
    strengthFlat: () => 'No lift improved its best estimated one-rep max. Review progression, rest and sets near failure.',
    suggestions: (v) => `${v.count} progression suggestion(s) are waiting for your decision.`,
    adjust: {
      fewer: 'Reduce the weekly training days to what the client really manages, then build up.',
      nutrition: 'Review the nutrition plan and make daily food logging a task.',
      sleep: 'Add a sleep routine task and keep hard sessions away from short-sleep days.',
      progress: 'Increase the weight of lifts that hit the top of their repetition range twice in a row.',
      deload: 'Plan a lighter week to recover, then return to the usual volume.',
      keep: 'Keep the current plan: the numbers show steady, healthy progress.',
    },
    summary: (n) => `${n} finding(s) from the real numbers of the last days.`,
  },
  ar: {
    low: (v) => `الالتزام بالتمرين منخفض: ${v.done} تمرينًا خلال ${v.days} يومًا مقابل حوالي ${v.expected} مخطط لها. اسأل عما يعيقه وفكّر في جلسات أقل وأقصر مؤقتًا.`,
    ok: (v) => `الالتزام بالتمرين جيد: ${v.done} تمرينًا خلال ${v.days} يومًا (المخطط حوالي ${v.expected}).`,
    none: () => 'لم يُسجَّل أي تمرين في هذه الفترة. تواصل مع العميل قبل تعديل الخطة.',
    weightLoss: (v) => `تغيّر الوزن بمقدار ${v.change} كجم (من ${v.start} إلى ${v.end} كجم)، وهذا يتماشى مع هدف خسارة الدهون.`,
    weightWrong: (v) => `تغيّر الوزن بمقدار ${v.change} كجم (من ${v.start} إلى ${v.end} كجم) عكس اتجاه الهدف. راجع التغذية أولًا.`,
    weightGain: (v) => `تغيّر الوزن بمقدار +${v.change} كجم (من ${v.start} إلى ${v.end} كجم)، وهذا يتماشى مع هدف بناء العضلات.`,
    weightFlat: (v) => `الوزن شبه ثابت (${v.change} كجم). إذا كان الهدف تغيير الجسم فعدّل السعرات بنسبة 5-10%.`,
    foodLow: (v) => `سُجّل الأكل في ${v.foodDays} يومًا فقط من ${v.days}، فصورة التغذية غير مكتملة. اطلب التسجيل اليومي.`,
    calories: (v) => `متوسط السعرات ${v.avg} سعرة مقابل هدف ${v.goal} سعرة (${v.diff}%). عدّل الكميات أو الهدف.`,
    sleepLow: (v) => `متوسط النوم ${v.avg} ساعة، أقل من 7. ضعف الاستشفاء يحدّ من التقدم: أضف مهمة للنوم.`,
    checkinLow: (v) => `المتابعات الأسبوعية تُظهر التزامًا بالتمرين ${v.avg}/10. ناقش ما صعّب الأسابيع.`,
    energyLow: (v) => `تم تقييم الطاقة ${v.avg}/5 في آخر المتابعات. فكّر في أسبوع أخف (ديلود).`,
    noCheckins: () => 'لم تصل متابعات أسبوعية. ذكّر العميل بإرسال واحدة.',
    strengthUp: (v) => `القوة في ارتفاع: ${v.list}.`,
    strengthFlat: () => 'لم يتحسن أي تمرين في أفضل 1RM مقدّر. راجع التدرج والراحة والمجموعات القريبة من الفشل.',
    suggestions: (v) => `هناك ${v.count} اقتراح لزيادة الأحمال بانتظار قرارك.`,
    adjust: {
      fewer: 'قلّل أيام التدريب الأسبوعية إلى ما يستطيعه العميل فعلًا ثم ارفعها تدريجيًا.',
      nutrition: 'راجع خطة التغذية واجعل تسجيل الأكل اليومي مهمة.',
      sleep: 'أضف مهمة لروتين النوم وتجنّب الجلسات الشاقة بعد الليالي القصيرة.',
      progress: 'ارفع وزن التمارين التي وصل فيها العميل إلى أعلى التكرارات مرتين متتاليتين.',
      deload: 'خطّط لأسبوع أخف للاستشفاء ثم عد إلى الحجم المعتاد.',
      keep: 'أبقِ الخطة كما هي: الأرقام تُظهر تقدمًا ثابتًا وصحيًا.',
    },
    summary: (n) => `${n} ملاحظة من الأرقام الحقيقية للأيام الماضية.`,
  },
};

const kcalDiff = (avg, goal) => Math.round(((avg - goal) / goal) * 100);

function exerciseLabel(row, language) {
  return (language === 'ar' && row.exercise_name_i18n?.ar) || row.exercise_name;
}

// What the numbers say about one client, as findings with a severity and a few concrete changes to the plan.
export function analyzeClientRules(data, { language = 'en' } = {}) {
  const text = TEXT[language] || TEXT.en;
  const days = num(data?.days) || 30;
  const stats = data?.stats || {};
  const intake = data?.intake || null;
  const findings = [];
  const adjust = new Set();

  const done = num(stats.workouts) || 0;
  const perWeek = num(intake?.training_days_per_week);
  const expected = perWeek ? Math.max(1, Math.round((perWeek * days) / 7)) : null;
  if (done === 0) {
    findings.push({ severity: 'warning', key: 'workouts', text: text.none() });
    adjust.add('fewer');
  } else if (expected && done < expected * 0.6) {
    findings.push({ severity: 'warning', key: 'workouts', text: text.low({ done, days, expected }) });
    adjust.add('fewer');
  } else if (expected) {
    findings.push({ severity: 'success', key: 'workouts', text: text.ok({ done, days, expected }) });
  }

  const change = num(stats.weight_change_kg);
  if (change !== null) {
    const goal = intake?.primary_goal;
    const view = { change: rounded(change), start: num(stats.weight_start_kg), end: num(stats.weight_end_kg) };
    if (goal === 'fat_loss') findings.push(change < -0.2 ? { severity: 'success', key: 'weight', text: text.weightLoss(view) } : { severity: 'warning', key: 'weight', text: change > 0.2 ? text.weightWrong(view) : text.weightFlat(view) });
    else if (goal === 'muscle_gain') findings.push(change > 0.2 ? { severity: 'success', key: 'weight', text: text.weightGain(view) } : { severity: 'warning', key: 'weight', text: change < -0.2 ? text.weightWrong(view) : text.weightFlat(view) });
    const againstGoal = (change > 0.2 && goal === 'fat_loss') || (change < -0.2 && goal === 'muscle_gain');
    const standing = Math.abs(change) <= 0.2 && ['fat_loss', 'muscle_gain'].includes(goal);
    if (againstGoal || standing) adjust.add('nutrition');
  }

  const foodDays = num(stats.food_days) || 0;
  if (foodDays < days * 0.4) {
    findings.push({ severity: 'info', key: 'food', text: text.foodLow({ foodDays, days }) });
    adjust.add('nutrition');
  }
  const targetCalories = num(data?.nutrition_target?.calories);
  const avgCalories = num(stats.avg_calories);
  if (targetCalories && avgCalories && Math.abs(kcalDiff(avgCalories, targetCalories)) > 15) {
    findings.push({ severity: 'info', key: 'calories', text: text.calories({ avg: avgCalories, goal: targetCalories, diff: kcalDiff(avgCalories, targetCalories) }) });
    adjust.add('nutrition');
  }

  const sleep = num(stats.avg_sleep_hours);
  if (sleep !== null && sleep < 7) {
    findings.push({ severity: 'warning', key: 'sleep', text: text.sleepLow({ avg: sleep }) });
    adjust.add('sleep');
  }

  const checkins = Array.isArray(data?.checkins) ? data.checkins : [];
  if (checkins.length === 0) {
    findings.push({ severity: 'info', key: 'checkins', text: text.noCheckins() });
  } else {
    const adherence = rounded(average(checkins.map((row) => num(row.workout_adherence_1_10)).filter((value) => value !== null)));
    if (adherence !== null && adherence < 6) findings.push({ severity: 'warning', key: 'checkinAdherence', text: text.checkinLow({ avg: adherence }) });
    const energy = rounded(average(checkins.slice(0, 3).map((row) => num(row.energy_level_1_5)).filter((value) => value !== null)));
    if (energy !== null && energy <= 2.5) {
      findings.push({ severity: 'info', key: 'energy', text: text.energyLow({ avg: energy }) });
      adjust.add('deload');
    }
  }

  const improved = (data?.strength || []).filter((row) => num(row.best_before) !== null && num(row.best_now) > num(row.best_before));
  if (improved.length) {
    findings.push({
      severity: 'success',
      key: 'strength',
      text: text.strengthUp({ list: improved.slice(0, 3).map((row) => `${exerciseLabel(row, language)} ${num(row.best_before)} → ${num(row.best_now)} kg`).join(language === 'ar' ? '، ' : ', ') }),
    });
  } else if ((data?.strength || []).length && done >= 4) {
    findings.push({ severity: 'info', key: 'strength', text: text.strengthFlat() });
    adjust.add('progress');
  }

  const pending = num(data?.pending_suggestions) || 0;
  if (pending > 0) {
    findings.push({ severity: 'info', key: 'suggestions', text: text.suggestions({ count: pending }) });
    adjust.add('progress');
  }

  if (adjust.size === 0 && findings.some((finding) => finding.severity === 'success')) adjust.add('keep');
  const order = { warning: 0, info: 1, success: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { summary: text.summary(findings.length), findings, recommendations: [...adjust].map((key) => text.adjust[key]) };
}

// ----------------------------------------------------------------------------------------------- the report

const REPORT = {
  ar: {
    greeting: (name) => (name ? `مرحبًا ${name}،` : 'مرحبًا،'),
    intro: (days) => `هذا ملخص أدائك خلال آخر ${days} يومًا، من أرقامك الفعلية:`,
    workouts: (v) => `التمارين: أنجزت ${v.workouts} تمرينًا${v.sets ? ` و${v.sets} مجموعة` : ''}${v.volume ? `، بحجم إجمالي ${v.volume} كجم` : ''}.`,
    heaviest: (v) => `أثقل وزن رفعته: ${v.kg} كجم.`,
    strength: (v) => `القوة: ${v.list}.`,
    weight: (v) => `الوزن: ${v.start} ← ${v.end} كجم (${v.change > 0 ? '+' : ''}${v.change} كجم).`,
    food: (v) => `التغذية: سجّلت الأكل في ${v.days} يومًا${v.avg ? `، بمتوسط ${v.avg} سعرة يوميًا${v.goal ? ` (الهدف ${v.goal})` : ''}` : ''}.`,
    sleep: (v) => `النوم والحركة: متوسط النوم ${v.sleep ?? '—'} ساعة${v.steps ? ` ومتوسط ${v.steps} خطوة يوميًا` : ''}${v.water ? ` وشرب ${v.water} لتر ماء يوميًا في المتوسط` : ''}.`,
    habits: (v) => `العادات: ${v.list}.`,
    checkins: (v) => `المتابعات الأسبوعية: التزام التمرين ${v.workout}/10 والتغذية ${v.diet}/10 والطاقة ${v.energy}/5 في المتوسط.`,
    tasks: (v) => `المهام: أنجزت ${v.done} من ${v.assigned} (${v.rate}%).`,
    nothing: 'لا توجد بيانات كافية في هذه الفترة. ابدأ بتسجيل تمارينك وأكلك وأرسل متابعتك الأسبوعية لنتابع تقدمك معًا.',
    praise: 'استمر على هذا النهج، فالانتظام هو سر النتائج.',
    focus: (v) => `تركيزنا القادم: ${v.list}.`,
    close: 'أنا معك في كل خطوة.',
  },
  en: {
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    intro: (days) => `Here is your progress over the last ${days} days, from your real numbers:`,
    workouts: (v) => `Workouts: you completed ${v.workouts} workouts${v.sets ? ` and ${v.sets} sets` : ''}${v.volume ? `, a total volume of ${v.volume} kg` : ''}.`,
    heaviest: (v) => `Heaviest weight lifted: ${v.kg} kg.`,
    strength: (v) => `Strength: ${v.list}.`,
    weight: (v) => `Weight: ${v.start} → ${v.end} kg (${v.change > 0 ? '+' : ''}${v.change} kg).`,
    food: (v) => `Nutrition: you logged food on ${v.days} days${v.avg ? `, averaging ${v.avg} kcal a day${v.goal ? ` (goal ${v.goal})` : ''}` : ''}.`,
    sleep: (v) => `Sleep and movement: average sleep ${v.sleep ?? '—'} hours${v.steps ? `, ${v.steps} steps a day` : ''}${v.water ? `, ${v.water} L of water a day on average` : ''}.`,
    habits: (v) => `Habits: ${v.list}.`,
    checkins: (v) => `Weekly check-ins: workout adherence ${v.workout}/10, nutrition ${v.diet}/10 and energy ${v.energy}/5 on average.`,
    tasks: (v) => `Tasks: you completed ${v.done} of ${v.assigned} (${v.rate}%).`,
    nothing: 'There is not enough data in this period yet. Start logging your workouts and food and send your weekly check-in so we can follow your progress together.',
    praise: 'Keep going: consistency is what brings results.',
    focus: (v) => `Our focus next: ${v.list}.`,
    close: 'I am with you every step of the way.',
  },
};

// A draft the coach reviews, edits and sends: only real numbers, nothing invented. Arabic or English.
export function buildProgressReport(data, { language = 'ar', maxLength = 3000 } = {}) {
  const lang = language === 'en' ? 'en' : 'ar';
  const text = REPORT[lang];
  const stats = data?.stats || {};
  const lines = [text.greeting(stats.first_name), '', text.intro(num(data?.days) || num(stats.period_days) || 30)];
  let facts = 0;
  const add = (line) => { lines.push(`• ${line}`); facts += 1; };

  const workouts = num(stats.workouts) || 0;
  if (workouts > 0) {
    add(text.workouts({ workouts, sets: num(stats.sets_logged), volume: num(stats.volume_kg) ? Math.round(num(stats.volume_kg)).toLocaleString('en-US') : null }));
    if (num(stats.heaviest_kg)) add(text.heaviest({ kg: num(stats.heaviest_kg) }));
  }
  const lifts = (data?.strength || []).filter((row) => num(row.best_before) !== null && num(row.best_now) > num(row.best_before));
  const bests = lifts.length ? lifts : (data?.strength || []).slice(0, 2);
  if (bests.length) {
    const list = bests.slice(0, 3).map((row) => (num(row.best_before) !== null && num(row.best_now) > num(row.best_before)
      ? `${exerciseLabel(row, lang)}: ${num(row.best_before)} → ${num(row.best_now)} kg`
      : `${exerciseLabel(row, lang)}: ${num(row.best_now)} kg`)).join(lang === 'ar' ? '، ' : ', ');
    add(text.strength({ list }));
  }
  if (num(stats.weight_change_kg) !== null && num(stats.weight_start_kg) !== null) add(text.weight({ start: num(stats.weight_start_kg), end: num(stats.weight_end_kg), change: rounded(num(stats.weight_change_kg)) }));
  if ((num(stats.food_days) || 0) > 0) add(text.food({ days: num(stats.food_days), avg: num(stats.avg_calories), goal: num(data?.nutrition_target?.calories) }));
  const habits = data?.habits || {};
  if (num(stats.avg_sleep_hours) !== null || num(stats.avg_steps) || num(habits.avg_water_liters)) {
    add(text.sleep({ sleep: num(stats.avg_sleep_hours), steps: num(stats.avg_steps) ? Math.round(num(stats.avg_steps)).toLocaleString('en-US') : null, water: num(habits.avg_water_liters) }));
  }
  const custom = (habits.custom || []).filter((row) => num(row.days_done) > 0);
  if (custom.length) add(text.habits({ list: custom.slice(0, 4).map((row) => `${row.name}: ${num(row.days_done)}`).join(lang === 'ar' ? '، ' : ', ') }));
  const checkins = Array.isArray(data?.checkins) ? data.checkins : [];
  if (checkins.length) {
    const avg = (key) => rounded(average(checkins.map((row) => num(row[key])).filter((value) => value !== null)));
    if (avg('workout_adherence_1_10') !== null) add(text.checkins({ workout: avg('workout_adherence_1_10'), diet: avg('diet_adherence_1_10'), energy: avg('energy_level_1_5') }));
  }
  const tasks = stats.tasks || {};
  if ((num(tasks.assigned) || 0) > 0) add(text.tasks({ done: num(tasks.done) || 0, assigned: num(tasks.assigned), rate: num(tasks.rate) ?? 0 }));

  if (facts === 0) {
    lines.push('', text.nothing);
  } else {
    lines.push('', text.praise);
    const advice = analyzeClientRules(data, { language: lang }).recommendations;
    if (advice.length) lines.push(text.focus({ list: advice.slice(0, 2).join(lang === 'ar' ? ' و' : ' and ').replace(/\.$/, '') }));
  }
  lines.push('', text.close);
  return lines.join('\n').slice(0, maxLength);
}
