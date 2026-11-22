import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import FoodTargetProgress from './FoodTargetProgress.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { getNutritionTarget, listClientFoodLogs } from '../services/foodReviewService.js';
import { buildTargetProgress, calorieAdherence, groupLogsByDay } from '../services/foodReviewUtils.js';
import { setClientNutritionTargets } from '../services/healthService.js';
import { targetsToForm, validateTargetsForm } from '../services/healthUtils.js';

const MEAL_LABELS = { breakfast: 'mealBreakfast', lunch: 'mealLunch', dinner: 'mealDinner', snack: 'mealSnack' };
const RANGES = [7, 14, 30];
const GOAL_FIELDS = [
  { key: 'calories', labelKey: 'nutCalories' },
  { key: 'protein', labelKey: 'nutProtein' },
  { key: 'carbs', labelKey: 'nutCarbs' },
  { key: 'fats', labelKey: 'nutFats' },
];

// A coach's view of one client's nutrition: the daily goal (which the coach can set), and what the client logged
// each day. The food log itself is read-only here.
export default function ClientFoodReview({ clientId }) {
  const { t, locale } = useLocale();
  const today = getLocalDateString();
  const [days, setDays] = useState(7);
  const [state, setState] = useState({ status: 'loading', target: null, logs: [], error: '' });
  const [form, setForm] = useState(targetsToForm(null));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [target, logs] = await Promise.all([
        getNutritionTarget(clientId),
        listClientFoodLogs(clientId, shiftDate(today, -(days - 1)), today),
      ]);
      setState({ status: 'ready', target, logs, error: '' });
      setForm(targetsToForm(target));
    } catch (error) {
      setState({ status: 'error', target: null, logs: [], error: error.message });
    }
  }, [clientId, days, today]);

  useEffect(() => {
    setState((current) => ({ ...current, status: 'loading' }));
    load();
  }, [load]);

  const byDay = useMemo(() => groupLogsByDay(state.logs, today, days), [state.logs, today, days]);
  const adherence = calorieAdherence(byDay, state.target);

  async function saveTargets(event) {
    event.preventDefault();
    const result = validateTargetsForm(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setSaving(true);
    setNotice(null);
    try {
      await setClientNutritionTargets(clientId, result.payload);
      await load();
      setNotice({ kind: 'info', text: t('nutTargetsSaved') });
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('nutSaveError')} ${error.message}` });
    } finally {
      setSaving(false);
    }
  }

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{t('foodReviewLoadError')} {state.error}</div>;

  const dayLabel = (date) => new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="food-review">
      <p className="muted-copy">{t('foodReviewReadOnly')}</p>

      <form className="health-targets-form" onSubmit={saveTargets} noValidate>
        <h5>{t('foodReviewTarget')}</h5>
        <div className="food-macro-grid">
          {GOAL_FIELDS.map((field) => (
            <label className="form-label" key={field.key}>{t(field.labelKey)}
              <input className="field" type="number" inputMode="decimal" min="0" step="1" value={form[field.key]} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))} aria-invalid={Boolean(errors[field.key])} />
              {errors[field.key] && <small className="field-error">{t(errors[field.key])}</small>}
            </label>
          ))}
        </div>
        {!state.target && <small className="muted-copy">{t('foodReviewNoTarget')}</small>}
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        <Button variant="secondary" type="submit" disabled={saving}>{saving ? t('nutSaving') : t('nutTargetsSave')}</Button>
      </form>

      <div className="food-review-range" role="group" aria-label={t('foodReviewRange')}>
        {RANGES.map((range) => (
          <button key={range} type="button" className={`choice-chip ${days === range ? 'is-selected' : ''}`} aria-pressed={days === range} onClick={() => setDays(range)}>
            {range} {t('foodReviewDays')}
          </button>
        ))}
      </div>

      {adherence && adherence.loggedDays > 0 && (
        <p className="food-review-summary">
          {t('foodReviewAdherence')}: <strong>{adherence.withinGoal}/{adherence.loggedDays}</strong> · {t('foodReviewAverage')}: <strong>{adherence.average.toLocaleString(locale)} {t('kcal')}</strong>
        </p>
      )}
      {state.logs.length === 0 && <div className="empty-state">{t('foodReviewNoLogs')}</div>}

      <div className="food-review-days">
        {byDay.map((day, index) => {
          const rows = buildTargetProgress(state.target, day.totals);
          return (
            <details className="food-review-day" key={day.date} open={index === 0 && day.count > 0}>
              <summary>
                <span>{dayLabel(day.date)}{day.date === today ? ` · ${t('chatDay_today')}` : ''}</span>
                <span className="food-review-day-totals" dir="auto">
                  {day.count > 0 ? `${day.totals.calories.toLocaleString(locale)} ${t('kcal')} · ${t('foodProtein')} ${day.totals.protein_g} · ${t('foodCarbs')} ${day.totals.carbs_g} · ${t('foodFat')} ${day.totals.fat_g}` : t('foodReviewNothingLogged')}
                </span>
              </summary>
              {day.count > 0 && rows.length > 0 && <FoodTargetProgress rows={rows} />}
              {day.meals.map((group) => (
                <div className="food-meal" key={group.meal}>
                  <h4>{t(MEAL_LABELS[group.meal])}</h4>
                  {group.items.map((log) => (
                    <article className="food-entry" key={log.id}>
                      <div>
                        <strong dir="auto">{log.food_name}</strong>
                        {log.ingredients && <p className="muted-copy" dir="auto">{log.ingredients}</p>}
                        <small>
                          {log.calories} {t('kcal')}
                          {log.protein_g !== null && ` · ${t('foodProtein')}: ${log.protein_g}`}
                          {log.carbs_g !== null && ` · ${t('foodCarbs')}: ${log.carbs_g}`}
                          {log.fat_g !== null && ` · ${t('foodFat')}: ${log.fat_g}`}
                        </small>
                      </div>
                    </article>
                  ))}
                </div>
              ))}
            </details>
          );
        })}
      </div>
    </div>
  );
}
