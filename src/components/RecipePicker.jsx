import { useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { filterRecipes, recipeToPlanFood } from '../services/recipeUtils.js';
import { listMyRecipes } from '../services/recipeService.js';

// Chooses one of the coach's recipes and how many servings of it go into a meal. The recipe becomes one food of the plan
// (its calories and macros for that portion), linked to the recipe so the client can open the method.
export default function RecipePicker({ onPick, onClose }) {
  const { t } = useLocale();
  const [state, setState] = useState({ status: 'loading', items: [], error: '' });
  const [query, setQuery] = useState('');
  const [portions, setPortions] = useState('1');

  useEffect(() => {
    let active = true;
    listMyRecipes()
      .then((items) => active && setState({ status: 'ready', items, error: '' }))
      .catch((error) => active && setState({ status: 'error', items: [], error: error.message }));
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => filterRecipes(state.items, query).slice(0, 12), [state.items, query]);
  const amount = Number(portions);
  const validAmount = Number.isFinite(amount) && amount > 0 && amount <= 20;

  return (
    <div className="food-picker recipe-picker">
      <div className="food-picker-bar">
        <input className="field" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('rcSearchPlaceholder')} aria-label={t('rcSearchPlaceholder')} autoFocus dir="auto" />
        <label className="recipe-portions">{t('rcPortions')}
          <input className="field" type="number" inputMode="decimal" min="0.25" max="20" step="0.25" value={portions} onChange={(event) => setPortions(event.target.value)} aria-invalid={!validAmount} />
        </label>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('hbClose')}>{'\u2715'}</button>
      </div>
      {state.status === 'loading' && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
      {state.status === 'error' && <p className="field-error" role="alert">{state.error}</p>}
      {state.status === 'ready' && state.items.length === 0 && <p className="muted-copy">{t('rcPickerEmpty')}</p>}
      {state.status === 'ready' && state.items.length > 0 && visible.length === 0 && <p className="muted-copy">{t('mpNoResults')}</p>}
      {visible.length > 0 && (
        <ul className="food-picker-results">
          {visible.map((recipe) => (
            <li key={recipe.id}>
              <button type="button" disabled={!validAmount} onClick={() => onPick(recipeToPlanFood(recipe, amount))}>
                <strong dir="auto">{recipe.title}</strong>
                <small dir="ltr">{recipe.per_serving.calories} kcal · P {recipe.per_serving.protein_g} · C {recipe.per_serving.carbs_g} · F {recipe.per_serving.fat_g} / {t('rcServingShort')}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" size="small" type="button" onClick={onClose}>{t('hbClose')}</Button>
    </div>
  );
}
