import { useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import FoodPicker from './FoodPicker.jsx';
import FoodTargetProgress from './FoodTargetProgress.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { clientLabel } from '../services/coachingUtils.js';
import { buildTargetProgress } from '../services/foodReviewUtils.js';
import { getNutritionTarget } from '../services/foodReviewService.js';
import {
  MAX_ALTERNATIVES, MAX_PLAN_FOODS, MEAL_LABELS, MEAL_TYPES, gramsToMatchCalories, itemsOfMeal, mealTotals, newKey, planTotals, validatePlan, withGrams,
} from '../services/mealPlanUtils.js';
import { saveMealPlan } from '../services/mealPlanService.js';

const macroLine = (food, t) => `${food.calories} ${t('kcal')} · ${t('foodProtein')} ${food.protein_g} · ${t('foodCarbs')} ${food.carbs_g} · ${t('foodFat')} ${food.fat_g}`;

// Builds or edits one meal plan: foods per meal with amounts in grams (calories and macros are calculated), alternatives
// for each food, and saving it as a template or giving it to a client.
export default function MealPlanEditor({ initial, clients, onSaved, onCancel }) {
  const { t } = useLocale();
  const [plan, setPlan] = useState(initial);
  const [picker, setPicker] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [target, setTarget] = useState(null);

  useEffect(() => {
    setPlan(initial);
    setPicker(null);
    setErrors({});
    setFailure('');
  }, [initial]);

  useEffect(() => {
    let active = true;
    setTarget(null);
    if (plan.is_template || !plan.client_id) return undefined;
    getNutritionTarget(plan.client_id).then((row) => active && setTarget(row)).catch(() => {});
    return () => { active = false; };
  }, [plan.is_template, plan.client_id]);

  const totals = useMemo(() => planTotals(plan.items), [plan.items]);
  const progress = useMemo(() => buildTargetProgress(target, totals), [target, totals]);
  const update = (patch) => setPlan((current) => ({ ...current, ...patch }));
  const updateItem = (key, patch) => setPlan((current) => ({ ...current, items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) }));
  const removeItem = (key) => setPlan((current) => ({ ...current, items: current.items.filter((item) => item.key !== key) }));

  function addFood(meal, food) {
    if (plan.items.length >= MAX_PLAN_FOODS) return;
    setPlan((current) => ({ ...current, items: [...current.items, { ...food, key: newKey(), meal_type: meal, notes: '', alternatives: [] }] }));
    setPicker(null);
  }

  function addAlternative(itemKey, food) {
    setPlan((current) => ({
      ...current,
      items: current.items.map((item) => {
        if (item.key !== itemKey || item.alternatives.length >= MAX_ALTERNATIVES) return item;
        const grams = gramsToMatchCalories(food.per100, item.calories);
        return { ...item, alternatives: [...item.alternatives, { ...withGrams(food, grams), key: newKey() }] };
      }),
    }));
    setPicker(null);
  }

  const setAlternativeGrams = (itemKey, altKey, grams) => setPlan((current) => ({
    ...current,
    items: current.items.map((item) => (item.key === itemKey
      ? { ...item, alternatives: item.alternatives.map((alt) => (alt.key === altKey ? { ...alt, ...withGrams(alt, grams) } : alt)) }
      : item)),
  }));

  const removeAlternative = (itemKey, altKey) => setPlan((current) => ({
    ...current,
    items: current.items.map((item) => (item.key === itemKey ? { ...item, alternatives: item.alternatives.filter((alt) => alt.key !== altKey) } : item)),
  }));

  async function save(event) {
    event.preventDefault();
    const result = validatePlan(plan);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy(true);
    setFailure('');
    try {
      const id = await saveMealPlan({ id: plan.id, title: result.payload.title, notes: result.payload.notes, isTemplate: plan.is_template, clientId: plan.client_id, items: result.payload.items });
      await onSaved(id);
    } catch (error) {
      setFailure(`${t('mpSaveError')} ${error.message}`);
      setBusy(false);
    }
  }

  const fieldError = (key) => errors[key] && <small className="field-error" role="alert">{t(errors[key])}</small>;

  return (
    <form className="panel meal-plan-editor" onSubmit={save} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('mpTitle')}</span><h3>{plan.id ? t('mpEditPlan') : t('mpNewPlan')}</h3></div></div>
      <label className="form-label">{t('mpPlanName')}
        <input className="field" value={plan.title} maxLength={120} onChange={(event) => update({ title: event.target.value })} aria-invalid={Boolean(errors.title)} dir="auto" />
        {fieldError('title')}
      </label>
      <label className="form-label">{t('mpPlanNotes')}
        <textarea className="field" rows={2} maxLength={2000} value={plan.notes} placeholder={t('mpPlanNotesPlaceholder')} onChange={(event) => update({ notes: event.target.value })} dir="auto" />
        {fieldError('notes')}
      </label>

      <fieldset className="meal-plan-target-picker">
        <legend>{t('mpSaveAs')}</legend>
        <label className="habit-kind-option"><input type="radio" name="plan-mode" checked={plan.is_template} onChange={() => update({ is_template: true, client_id: null })} /><span><strong>{t('mpTemplate')}</strong><small>{t('mpTemplateHelp')}</small></span></label>
        <label className="habit-kind-option"><input type="radio" name="plan-mode" checked={!plan.is_template} onChange={() => update({ is_template: false })} /><span><strong>{t('mpForClient')}</strong><small>{t('mpForClientHelp')}</small></span></label>
        {!plan.is_template && (
          <select className="field" aria-label={t('mpChooseClient')} value={plan.client_id || ''} onChange={(event) => update({ client_id: event.target.value || null })} aria-invalid={Boolean(errors.client)}>
            <option value="">{t('mpChooseClient')}</option>
            {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
          </select>
        )}
        {fieldError('client')}
      </fieldset>

      {MEAL_TYPES.map((meal) => {
        const foods = itemsOfMeal(plan.items, meal);
        const subtotal = mealTotals(plan.items, meal);
        return (
          <section className="meal-plan-meal" key={meal} aria-label={t(MEAL_LABELS[meal])}>
            <header>
              <h4>{t(MEAL_LABELS[meal])}</h4>
              <small dir="auto">{foods.length ? macroLine(subtotal, t) : ''}</small>
            </header>
            {foods.map((item) => (
              <article className="meal-plan-food" key={item.key}>
                <div className="meal-plan-food-main">
                  <strong dir="auto">{item.food_name}</strong>
                  <label className="meal-plan-grams"><span className="visually-hidden">{t('mpGrams')}</span>
                    <input className="field" type="number" inputMode="decimal" min="1" max="5000" step="1" value={item.grams} onChange={(event) => updateItem(item.key, withGrams(item, event.target.value))} aria-label={`${item.food_name} ${t('mpGrams')}`} /> <span>{t('mpGramsShort')}</span>
                  </label>
                  <button type="button" className="icon-button" onClick={() => removeItem(item.key)} aria-label={`${t('mpRemoveFood')}: ${item.food_name}`}>{'\u2715'}</button>
                </div>
                <small dir="auto">{macroLine(item, t)}</small>
                {item.alternatives.length > 0 && (
                  <ul className="meal-plan-alternatives" aria-label={t('mpAlternatives')}>
                    {item.alternatives.map((alt) => (
                      <li key={alt.key}>
                        <span dir="auto"><strong>{alt.food_name}</strong> <small>{macroLine(alt, t)}</small></span>
                        <span className="meal-plan-alt-actions">
                          <input className="field" type="number" inputMode="decimal" min="1" max="5000" value={alt.grams} onChange={(event) => setAlternativeGrams(item.key, alt.key, event.target.value)} aria-label={`${alt.food_name} ${t('mpGrams')}`} />
                          <button type="button" className="icon-button" onClick={() => removeAlternative(item.key, alt.key)} aria-label={`${t('mpRemoveFood')}: ${alt.food_name}`}>{'\u2715'}</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {item.alternatives.length < MAX_ALTERNATIVES && picker?.itemKey !== item.key && (
                  <button type="button" className="text-action" onClick={() => setPicker({ meal, itemKey: item.key })}>+ {t('mpAddAlternative')}</button>
                )}
                {picker?.itemKey === item.key && <FoodPicker onPick={(food) => addAlternative(item.key, food)} onClose={() => setPicker(null)} />}
              </article>
            ))}
            {picker && picker.meal === meal && !picker.itemKey
              ? <FoodPicker onPick={(food) => addFood(meal, food)} onClose={() => setPicker(null)} />
              : <Button variant="secondary" size="small" type="button" onClick={() => setPicker({ meal, itemKey: null })} disabled={plan.items.length >= MAX_PLAN_FOODS}>+ {t('mpAddFood')}</Button>}
          </section>
        );
      })}
      {fieldError('items')}

      <div className="meal-plan-total">
        <strong>{t('mpDayTotal')}</strong>
        <span dir="auto">{macroLine(totals, t)}</span>
      </div>
      {progress.length > 0 && <FoodTargetProgress rows={progress} />}
      {!plan.is_template && plan.client_id && !target && <small className="muted-copy">{t('mpNoTarget')}</small>}

      {failure && <div className="notice notice-error" role="alert">{failure}</div>}
      <div className="habit-modal-actions">
        <Button variant="secondary" type="button" onClick={onCancel}>{t('hbCancel')}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? t('hbSaving') : t(plan.is_template ? 'mpSaveTemplate' : 'mpSaveForClient')}</Button>
      </div>
    </form>
  );
}