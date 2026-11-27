import { useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import FoodPicker from './FoodPicker.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { newKey, withGrams } from '../services/mealPlanUtils.js';
import {
  MAX_MINUTES, MAX_RECIPE_DESCRIPTION, MAX_RECIPE_INGREDIENTS, MAX_RECIPE_INSTRUCTIONS, MAX_RECIPE_TITLE, MAX_SERVINGS,
  perServing, recipeTotals, validateRecipe,
} from '../services/recipeUtils.js';
import { saveRecipe } from '../services/recipeService.js';

const macroLine = (food, t) => `${food.calories} ${t('kcal')} · ${t('foodProtein')} ${food.protein_g} · ${t('foodCarbs')} ${food.carbs_g} · ${t('foodFat')} ${food.fat_g}`;

// Builds or edits one recipe: ingredients picked from the built-in foods (or typed) with amounts in grams, the number of
// servings, times and the method. The calories and macros of the whole recipe and of one serving follow the ingredients.
export default function RecipeEditor({ initial, onSaved, onCancel }) {
  const { t } = useLocale();
  const [recipe, setRecipe] = useState(initial);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    setRecipe(initial);
    setPicking(false);
    setErrors({});
    setFailure('');
  }, [initial]);

  const totals = useMemo(() => recipeTotals(recipe.items), [recipe.items]);
  const serving = useMemo(() => perServing(totals, recipe.servings), [totals, recipe.servings]);
  const update = (patch) => setRecipe((current) => ({ ...current, ...patch }));
  const updateItem = (key, patch) => setRecipe((current) => ({ ...current, items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) }));
  const removeItem = (key) => setRecipe((current) => ({ ...current, items: current.items.filter((item) => item.key !== key) }));

  function addIngredient(food) {
    if (recipe.items.length >= MAX_RECIPE_INGREDIENTS) return;
    setRecipe((current) => ({ ...current, items: [...current.items, { ...food, key: newKey(), notes: '' }] }));
    setPicking(false);
  }

  async function save(event) {
    event.preventDefault();
    const result = validateRecipe(recipe);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy(true);
    setFailure('');
    try {
      const id = await saveRecipe({ id: recipe.id, ...result.payload });
      await onSaved(id);
    } catch (error) {
      setFailure(`${t('rcSaveError')} ${error.message}`);
      setBusy(false);
    }
  }

  const fieldError = (key) => errors[key] && <small className="field-error" role="alert">{t(errors[key])}</small>;

  return (
    <form className="panel recipe-editor" onSubmit={save} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('rcTitle')}</span><h3>{recipe.id ? t('rcEditRecipe') : t('rcNewRecipe')}</h3></div></div>
      <label className="form-label">{t('rcName')}
        <input className="field" value={recipe.title} maxLength={MAX_RECIPE_TITLE} onChange={(event) => update({ title: event.target.value })} aria-invalid={Boolean(errors.title)} dir="auto" />
        {fieldError('title')}
      </label>
      <label className="form-label">{t('rcDescription')}
        <textarea className="field" rows={2} maxLength={MAX_RECIPE_DESCRIPTION} value={recipe.description} placeholder={t('rcDescriptionPlaceholder')} onChange={(event) => update({ description: event.target.value })} dir="auto" />
        {fieldError('description')}
      </label>
      <div className="recipe-editor-grid">
        <label className="form-label">{t('rcServings')}
          <input className="field" type="number" inputMode="numeric" min="1" max={MAX_SERVINGS} step="1" value={recipe.servings} onChange={(event) => update({ servings: event.target.value })} aria-invalid={Boolean(errors.servings)} />
          {fieldError('servings')}
        </label>
        <label className="form-label">{t('rcPrep')} ({t('rcMin')})
          <input className="field" type="number" inputMode="numeric" min="0" max={MAX_MINUTES} step="1" value={recipe.prep_minutes} onChange={(event) => update({ prep_minutes: event.target.value })} aria-invalid={Boolean(errors.time)} />
        </label>
        <label className="form-label">{t('rcCook')} ({t('rcMin')})
          <input className="field" type="number" inputMode="numeric" min="0" max={MAX_MINUTES} step="1" value={recipe.cook_minutes} onChange={(event) => update({ cook_minutes: event.target.value })} aria-invalid={Boolean(errors.time)} />
        </label>
      </div>
      {fieldError('time')}

      <section className="recipe-ingredient-editor" aria-label={t('rcIngredients')}>
        <h4>{t('rcIngredients')}</h4>
        {recipe.items.map((item) => (
          <article className="meal-plan-food" key={item.key}>
            <div className="meal-plan-food-main">
              <strong dir="auto">{item.food_name}</strong>
              <label className="meal-plan-grams"><span className="visually-hidden">{t('mpGrams')}</span>
                <input className="field" type="number" inputMode="decimal" min="1" max="5000" step="1" value={item.grams} onChange={(event) => updateItem(item.key, withGrams(item, event.target.value))} aria-label={`${item.food_name} ${t('mpGrams')}`} /> <span>{t('mpGramsShort')}</span>
              </label>
              <button type="button" className="icon-button" onClick={() => removeItem(item.key)} aria-label={`${t('mpRemoveFood')}: ${item.food_name}`}>{'\u2715'}</button>
            </div>
            <small dir="auto">{macroLine(item, t)}</small>
          </article>
        ))}
        {picking
          ? <FoodPicker onPick={addIngredient} onClose={() => setPicking(false)} />
          : <Button variant="secondary" size="small" type="button" onClick={() => setPicking(true)} disabled={recipe.items.length >= MAX_RECIPE_INGREDIENTS}>+ {t('rcAddIngredient')}</Button>}
        {fieldError('items')}
      </section>

      <div className="recipe-macros" aria-live="polite">
        <div><span className="eyebrow">{t('rcPerServing')}</span><strong dir="auto">{macroLine(serving, t)}</strong></div>
        <div><span className="eyebrow">{t('rcWholeRecipe')}</span><small dir="auto">{macroLine(totals, t)} · {totals.grams} {t('mpGramsShort')}</small></div>
      </div>

      <label className="form-label">{t('rcMethod')}
        <textarea className="field intake-textarea" rows={6} maxLength={MAX_RECIPE_INSTRUCTIONS} value={recipe.instructions} placeholder={t('rcMethodPlaceholder')} onChange={(event) => update({ instructions: event.target.value })} dir="auto" />
        {fieldError('instructions')}
      </label>

      {failure && <div className="notice notice-error" role="alert">{failure}</div>}
      <div className="habit-modal-actions">
        <Button variant="secondary" type="button" onClick={onCancel}>{t('hbCancel')}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? t('hbSaving') : t('rcSave')}</Button>
      </div>
    </form>
  );
}
