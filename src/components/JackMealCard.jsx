import { useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { normalizeFoodEntry } from '../services/clientPriority2Utils.js';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS = { breakfast: 'mealBreakfast', lunch: 'mealLunch', dinner: 'mealDinner', snack: 'mealSnack' };
const num = (value) => (value === null || value === undefined ? '' : String(value));

// Jack's estimate of a meal from a photo. The client corrects the numbers, then saves it to the food log.
export default function JackMealCard({ meal, saved, onSave }) {
  const { t } = useLocale();
  const [form, setForm] = useState({
    food_name: meal.food_name || '',
    meal_type: meal.meal_type || 'lunch',
    calories: num(meal.calories),
    protein_g: num(meal.protein_g),
    carbs_g: num(meal.carbs_g),
    fat_g: num(meal.fat_g),
    ingredients: meal.ingredients || '',
  });
  const [state, setState] = useState({ busy: false, error: '' });
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));

  async function save(event) {
    event.preventDefault();
    let entry;
    try {
      entry = normalizeFoodEntry(form);
    } catch (problem) {
      setState({ busy: false, error: problem.message });
      return;
    }
    setState({ busy: true, error: '' });
    try {
      await onSave(entry);
      setState({ busy: false, error: '' });
    } catch {
      setState({ busy: false, error: t('jackMealSaveError') });
    }
  }

  return (
    <form className={`jack-meal ${saved ? 'is-saved' : ''}`} onSubmit={save} aria-label={t('jackMealTitle')}>
      <div className="jack-meal-head">
        <strong>{'\u{1F37D}\uFE0F'} {t('jackMealTitle')}</strong>
        <small>{t('jackMealEstimate')}</small>
      </div>
      <label className="jack-meal-field">{t('foodName')}
        <input className="field" value={form.food_name} maxLength={160} onChange={set('food_name')} disabled={saved} />
      </label>
      <label className="jack-meal-field">{t('mealType')}
        <select className="field" value={form.meal_type} onChange={set('meal_type')} disabled={saved}>
          {MEALS.map((meal_type) => <option key={meal_type} value={meal_type}>{t(MEAL_LABELS[meal_type])}</option>)}
        </select>
      </label>
      <div className="jack-meal-macros">
        {[['calories', 'jackMealKcal'], ['protein_g', 'jackMealProtein'], ['carbs_g', 'jackMealCarbs'], ['fat_g', 'jackMealFat']].map(([name, label]) => (
          <label className="jack-meal-field" key={name}>{t(label)}
            <input className="field" type="number" inputMode="decimal" min="0" step="0.1" value={form[name]} onChange={set(name)} disabled={saved} dir="ltr" />
          </label>
        ))}
      </div>
      {form.ingredients && <small className="jack-meal-ingredients" dir="auto">{form.ingredients}</small>}
      {state.error && <div className="notice notice-error" role="alert">{state.error}</div>}
      {saved
        ? <div className="notice notice-info" role="status">{t('jackMealSaved')}</div>
        : <button className="jack-meal-save" type="submit" disabled={state.busy}>{state.busy ? t('jackMealSaving') : t('jackMealSave')}</button>}
    </form>
  );
}