import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import FoodTargetProgress from './FoodTargetProgress.jsx';
import RecipeView from './RecipeView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { getNutritionTarget } from '../services/foodReviewService.js';
import { buildTargetProgress } from '../services/foodReviewUtils.js';
import { getMyMealPlan, logMealPlanItems } from '../services/mealPlanService.js';
import { getRecipe } from '../services/recipeService.js';
import { MEAL_LABELS, MEAL_TYPES, buildLogChoices, chosenFood, itemsOfMeal, sumFoods } from '../services/mealPlanUtils.js';
import { getCurrentUserId } from '../services/clientIdentity.js';
import { requireSupabase } from '../services/supabaseClient.js';

const macros = (food, t) => `${Number(food.calories)} ${t('kcal')} · ${t('foodProtein')} ${Number(food.protein_g)} · ${t('foodCarbs')} ${Number(food.carbs_g)} · ${t('foodFat')} ${Number(food.fat_g)}`;

// The client's meal plan inside the food page: each meal with its foods, grams and macros, the alternatives the coach
// allowed, and a button that copies a meal (or one food) into today's food log.
export default function ClientMealPlan({ onLogged }) {
  const { t, locale } = useLocale();
  const today = getLocalDateString();
  const [state, setState] = useState({ status: 'loading', plan: null, target: null, error: '' });
  const [selections, setSelections] = useState({});
  const [logged, setLogged] = useState({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [recipeDialog, setRecipeDialog] = useState(null); // { status, recipe, error }

  const load = useCallback(async () => {
    try {
      const plan = await getMyMealPlan();
      const target = plan ? await getNutritionTarget(await getCurrentUserId(requireSupabase())).catch(() => null) : null;
      setState({ status: 'ready', plan, target, error: '' });
    } catch (error) {
      setState({ status: 'error', plan: null, target: null, error: error.message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const items = state.plan?.items || [];
  const totals = useMemo(() => sumFoods(items.map((item) => chosenFood(item, selections))), [items, selections]);
  const progress = useMemo(() => buildTargetProgress(state.target, totals), [state.target, totals]);

  async function log(scope, scopeItems) {
    setBusy(scope);
    setNotice(null);
    try {
      await logMealPlanItems(state.plan.id, today, buildLogChoices(scopeItems, selections));
      setLogged((current) => ({ ...current, [scope]: true }));
      setNotice({ kind: 'info', text: t('mpLogged') });
      onLogged?.();
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('mpLogError')} ${error.message}` });
    } finally {
      setBusy('');
    }
  }

  async function openRecipe(recipeId) {
    setRecipeDialog({ status: 'loading', recipe: null, error: '' });
    try {
      setRecipeDialog({ status: 'ready', recipe: await getRecipe(recipeId), error: '' });
    } catch (error) {
      setRecipeDialog({ status: 'error', recipe: null, error: error.message });
    }
  }

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{t('mpLoadError')} {state.error}</div>;
  if (!state.plan) return null;
  const plan = state.plan;

  return (
    <section className="panel client-meal-plan" aria-labelledby="client-meal-plan-title">
      <div className="panel-heading">
        <div><span className="eyebrow">{t('mpFromCoach')}{plan.coach_name ? ` · ${plan.coach_name}` : ''}</span><h3 id="client-meal-plan-title" dir="auto">{plan.title}</h3></div>
        <small dir="auto">{macros(totals, t)}</small>
      </div>
      {plan.notes && <p className="muted-copy" dir="auto">{plan.notes}</p>}
      {progress.length > 0 && <FoodTargetProgress rows={progress} />}
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      {MEAL_TYPES.map((meal) => {
        const foods = itemsOfMeal(items, meal);
        if (foods.length === 0) return null;
        const mealTotal = sumFoods(foods.map((item) => chosenFood(item, selections)));
        return (
          <article className="meal-plan-meal" key={meal}>
            <header>
              <h4>{t(MEAL_LABELS[meal])}</h4>
              <small dir="auto">{macros(mealTotal, t)}</small>
              <Button variant={logged[meal] ? 'secondary' : 'primary'} size="small" type="button" disabled={busy === meal} onClick={() => log(meal, foods)}>
                {logged[meal] ? t('mpLoggedAgain') : t('mpLogMeal')}
              </Button>
            </header>
            {foods.map((item) => {
              const picked = chosenFood(item, selections);
              const options = [{ id: 'original', value: null, food: item }, ...(item.alternatives || []).map((alt, index) => ({ id: `alt-${index}`, value: index, food: alt }))];
              return (
                <div className="meal-plan-food client" key={item.id}>
                  <div className="meal-plan-food-main">
                    <strong dir="auto">{picked.food_name}</strong>
                    <span dir="ltr">{Number(picked.grams).toLocaleString(locale)} {t('mpGramsShort')}</span>
                    {item.recipe_id && <button type="button" className="text-action" onClick={() => openRecipe(item.recipe_id)}>{'\uD83D\uDCD6'} {t('rcViewRecipe')}</button>}
                    <button type="button" className="text-action" disabled={busy === item.id} onClick={() => log(item.id, [item])}>{logged[item.id] ? t('mpLoggedAgain') : t('mpLogFood')}</button>
                  </div>
                  <small dir="auto">{macros(picked, t)}</small>
                  {item.notes && <small className="muted-copy" dir="auto">{item.notes}</small>}
                  {options.length > 1 && (
                    <div className="meal-plan-choices" role="radiogroup" aria-label={t('mpAlternatives')}>
                      {options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={(selections[item.id] ?? null) === option.value}
                          className={`choice-chip ${(selections[item.id] ?? null) === option.value ? 'is-selected' : ''}`}
                          onClick={() => setSelections((current) => ({ ...current, [item.id]: option.value }))}
                        >
                          {option.value === null ? t('mpOriginal') : option.food.food_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </article>
        );
      })}
      {recipeDialog && (
        <div className="habit-modal-backdrop" role="presentation" onClick={() => setRecipeDialog(null)}>
          <div className="habit-modal recipe-dialog" role="dialog" aria-modal="true" aria-label={t('rcViewRecipe')} onClick={(event) => event.stopPropagation()}>
            <div className="habit-modal-heading">
              <h2>{t('rcViewRecipe')}</h2>
              <button type="button" className="icon-button" onClick={() => setRecipeDialog(null)} aria-label={t('hbClose')}>{'\u2715'}</button>
            </div>
            {recipeDialog.status === 'loading' && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
            {recipeDialog.status === 'error' && <div className="notice notice-error" role="alert">{t('rcLoadError')} {recipeDialog.error}</div>}
            {recipeDialog.status === 'ready' && <RecipeView recipe={recipeDialog.recipe} />}
          </div>
        </div>
      )}
    </section>
  );
}