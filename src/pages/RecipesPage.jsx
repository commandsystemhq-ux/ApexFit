import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import RecipeEditor from '../components/RecipeEditor.jsx';
import RecipeView from '../components/RecipeView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PAGES } from '../routes.js';
import { deleteRecipe, getRecipe, listMyRecipes } from '../services/recipeService.js';
import { emptyRecipe, filterRecipes, hydrateRecipe, totalMinutes } from '../services/recipeUtils.js';

const macros = (food, t) => `${Number(food.calories)} ${t('kcal')} · ${t('foodProtein')} ${Number(food.protein_g)} · ${t('foodCarbs')} ${Number(food.carbs_g)} · ${t('foodFat')} ${Number(food.fat_g)}`;

// The coach's recipes: build complete recipes from the built-in foods (calories and macros are calculated), read them, and
// put them into meal plans from the meal plan builder.
export default function RecipesPage() {
  const { t } = useLocale();
  const [state, setState] = useState({ status: 'loading', recipes: [], error: '' });
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', recipes: await listMyRecipes(), error: '' });
    } catch (error) {
      setState({ status: 'error', recipes: [], error: error.message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => filterRecipes(state.recipes, query), [state.recipes, query]);
  const say = (kind, text) => setNotice({ kind, text });

  async function open(recipeId, mode) {
    setNotice(null);
    setBusyId(recipeId);
    try {
      const recipe = await getRecipe(recipeId);
      if (mode === 'edit') {
        setViewing(null);
        setEditing(hydrateRecipe(recipe));
      } else {
        setEditing(null);
        setViewing(recipe);
      }
    } catch (error) {
      say('error', `${t('rcLoadError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function remove(recipe) {
    if (!window.confirm(t('rcDeleteConfirm'))) return;
    setBusyId(recipe.id);
    setNotice(null);
    try {
      await deleteRecipe(recipe.id);
      if (editing?.id === recipe.id) setEditing(null);
      if (viewing?.id === recipe.id) setViewing(null);
      await load();
      say('info', t('rcDeleted'));
    } catch (error) {
      say('error', `${t('rcActionError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function saved() {
    setEditing(null);
    await load();
    say('info', t('rcSaved'));
  }

  return (
    <>
      <PageHeader
        eyebrow="APEXFIT"
        title={t('rcTitle')}
        description={t('rcDescriptionPage')}
        action={<Button variant="primary" onClick={() => { setNotice(null); setViewing(null); setEditing(emptyRecipe()); }}>{t('rcNewRecipe')}</Button>}
      />
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('rcLoadError')} {state.error}</div>}

      {editing && <RecipeEditor initial={editing} onSaved={saved} onCancel={() => setEditing(null)} />}
      {viewing && (
        <section className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">{t('rcTitle')}</span></div>
            <div className="page-heading-action">
              <Link className="button button-secondary button-small" to={PAGES.mealPlans.path}>{t('rcUseInPlan')}</Link>
              <button className="text-action" type="button" onClick={() => setViewing(null)}>{t('hbClose')}</button>
            </div>
          </div>
          <RecipeView recipe={viewing} />
        </section>
      )}

      {state.status === 'ready' && (
        <section className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">{t('rcTitle')}</span><h3>{t('rcMyRecipes')}</h3></div>
            {state.recipes.length > 5 && <input className="field" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('rcSearchPlaceholder')} aria-label={t('rcSearchPlaceholder')} dir="auto" />}
          </div>
          {state.recipes.length === 0 && <div className="empty-state">{t('rcEmpty')}</div>}
          {state.recipes.length > 0 && visible.length === 0 && <div className="empty-state">{t('mpNoResults')}</div>}
          <div className="recipe-grid">
            {visible.map((recipe) => (
              <article className="recipe-card" key={recipe.id}>
                <h4 dir="auto">{recipe.title}</h4>
                {recipe.description && <p className="muted-copy" dir="auto">{recipe.description}</p>}
                <small dir="auto"><strong>{t('rcPerServing')}:</strong> {macros(recipe.per_serving, t)}</small>
                <small className="muted-copy">
                  {t('rcServings')}: {recipe.servings}{totalMinutes(recipe) > 0 ? ` · ${totalMinutes(recipe)} ${t('rcMin')}` : ''}
                </small>
                <div className="meal-plan-row-actions">
                  <button className="text-action" type="button" disabled={busyId === recipe.id} onClick={() => open(recipe.id, 'view')}>{t('rcView')}</button>
                  <button className="text-action" type="button" disabled={busyId === recipe.id} onClick={() => open(recipe.id, 'edit')}>{t('mpEdit')}</button>
                  <button className="text-action rpt-delete" type="button" disabled={busyId === recipe.id} onClick={() => remove(recipe)}>{t('mpDelete')}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
