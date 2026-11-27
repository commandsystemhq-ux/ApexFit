import { useLocale } from '../contexts/LocaleContext.jsx';
import { splitSteps, totalMinutes } from '../services/recipeUtils.js';

const macros = (food, t) => `${Number(food.calories)} ${t('kcal')} · ${t('foodProtein')} ${Number(food.protein_g)} · ${t('foodCarbs')} ${Number(food.carbs_g)} · ${t('foodFat')} ${Number(food.fat_g)}`;

// A recipe for reading: the numbers (whole recipe and one serving), the ingredients with their grams, and the method as
// numbered steps. `recipe` is the result of get_recipe.
export default function RecipeView({ recipe }) {
  const { t, locale } = useLocale();
  const steps = splitSteps(recipe.instructions);
  const minutes = totalMinutes(recipe);
  const number = (value) => Number(value).toLocaleString(locale);

  return (
    <article className="recipe-view">
      <header>
        <h3 dir="auto">{recipe.title}</h3>
        {recipe.description && <p className="muted-copy" dir="auto">{recipe.description}</p>}
        <ul className="recipe-facts">
          <li>{t('rcServings')}: <strong>{number(recipe.servings)}</strong></li>
          {recipe.prep_minutes !== null && recipe.prep_minutes !== undefined && <li>{t('rcPrep')}: <strong>{number(recipe.prep_minutes)} {t('rcMin')}</strong></li>}
          {recipe.cook_minutes !== null && recipe.cook_minutes !== undefined && <li>{t('rcCook')}: <strong>{number(recipe.cook_minutes)} {t('rcMin')}</strong></li>}
          {minutes > 0 && <li>{t('rcTotalTime')}: <strong>{number(minutes)} {t('rcMin')}</strong></li>}
        </ul>
      </header>
      <div className="recipe-macros">
        <div><span className="eyebrow">{t('rcPerServing')}</span><strong dir="auto">{macros(recipe.per_serving, t)}</strong></div>
        <div><span className="eyebrow">{t('rcWholeRecipe')}</span><small dir="auto">{macros(recipe.totals, t)}</small></div>
      </div>
      <section>
        <h4>{t('rcIngredients')}</h4>
        <ul className="recipe-ingredients">
          {(recipe.ingredients || []).map((item) => (
            <li key={item.id || item.position}>
              <span dir="auto">{item.food_name}{item.notes ? <small className="muted-copy"> — {item.notes}</small> : null}</span>
              <span dir="ltr">{number(item.grams)} {t('mpGramsShort')}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>{t('rcMethod')}</h4>
        {steps.length === 0 ? <p className="muted-copy">{t('rcNoMethod')}</p> : (
          <ol className="recipe-steps">
            {steps.map((step, index) => <li key={`${index}-${step.slice(0, 12)}`} dir="auto">{step}</li>)}
          </ol>
        )}
      </section>
    </article>
  );
}
