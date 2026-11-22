import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { addFoodLog, deleteFoodLog, listFoodLogs } from '../services/clientFoodService.js';
import { MEAL_TYPES, summarizeFoodDay } from '../services/clientPriority2Utils.js';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { searchFoodDatabase } from '../services/foodSearchService.js';
import { MAX_PORTION_GRAMS, classifyFoodQuery, createDebouncer, defaultPortionGrams, scaleFoodPortion } from '../services/foodSearchUtils.js';

const MEAL_LABELS = { breakfast: 'mealBreakfast', lunch: 'mealLunch', dinner: 'mealDinner', snack: 'mealSnack' };
const EMPTY_ENTRY = { meal_type: 'breakfast', food_name: '', ingredients: '', calories: '', protein_g: '', carbs_g: '', fat_g: '' };

export default function ClientFoodLogger() {
  const { locale, t } = useLocale();
  const today = getLocalDateString();
  const [selectedDate, setSelectedDate] = useState(today);
  const [entry, setEntry] = useState(EMPTY_ENTRY);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchState, setSearchState] = useState('idle');
  const [searchStatus, setSearchStatus] = useState(0);
  const [results, setResults] = useState([]);
  const [selectedFood, setSelectedFood] = useState(null);
  const [grams, setGrams] = useState('');

  // The search is a convenience: any failure or empty answer leaves the manual fields below fully usable.
  useEffect(() => {
    const query = classifyFoodQuery(searchText, locale);
    if (!query) {
      setSearchState('idle');
      setResults([]);
      return undefined;
    }
    const controller = new AbortController();
    const debouncer = createDebouncer();
    setSearchState('loading');
    debouncer.schedule(async () => {
      try {
        const items = await searchFoodDatabase(query, { signal: controller.signal });
        setResults(items);
        setSearchState('done');
      } catch (error) {
        if (controller.signal.aborted) return;
        setResults([]);
        setSearchStatus(error.status || 0);
        setSearchState('error');
      }
    });
    return () => {
      debouncer.cancel();
      controller.abort();
    };
  }, [searchText, locale]);

  function fillFromPortion(food, amount) {
    const scaled = scaleFoodPortion(food.per100g, amount);
    if (!scaled) return;
    setEntry((current) => ({
      ...current,
      calories: String(scaled.calories),
      protein_g: String(scaled.protein_g),
      carbs_g: String(scaled.carbs_g),
      fat_g: String(scaled.fat_g),
    }));
  }

  function chooseFood(food) {
    const amount = defaultPortionGrams(food);
    setSuccess('');
    setSelectedFood(food);
    setGrams(String(amount));
    setEntry((current) => ({ ...current, food_name: food.name }));
    fillFromPortion(food, amount);
  }

  function changeGrams(value) {
    setSuccess('');
    setGrams(value);
    if (selectedFood) fillFromPortion(selectedFood, value);
  }

  function clearSearch() {
    setSearchText('');
    setResults([]);
    setSelectedFood(null);
    setGrams('');
  }

  async function refresh(date = selectedDate) {
    setLoading(true);
    setLoadError('');
    try {
      setLogs(await listFoodLogs(shiftDate(date, -6), date));
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(selectedDate);
  }, [selectedDate]);

  const dayLogs = logs.filter((log) => log.logged_on === selectedDate);
  const totals = summarizeFoodDay(dayLogs);
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(selectedDate, index - 6);
    return {
      date,
      calories: summarizeFoodDay(logs.filter((log) => log.logged_on === date)).calories,
      weekday: new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' }),
    };
  });
  const weekMax = Math.max(...week.map((day) => day.calories), 1);

  function updateEntry(field, value) {
    setSuccess('');
    setEntry((current) => ({ ...current, [field]: value }));
  }

  async function handleAdd(event) {
    event.preventDefault();
    setSaveError('');
    setSuccess('');
    setSaving(true);
    try {
      const portion = selectedFood && Number(grams) > 0
        ? [`${Number(grams)} ${t('foodGramsUnit')}`, selectedFood.brand].filter(Boolean).join(' · ')
        : '';
      await addFoodLog({ loggedOn: selectedDate, ...entry, ingredients: entry.ingredients.trim() || portion });
      setEntry((current) => ({ ...EMPTY_ENTRY, meal_type: current.meal_type }));
      clearSearch();
      setSuccess(t('foodAdded'));
      await refresh();
    } catch (error) {
      setSaveError(`${t('foodSaveError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setDeletingId(id);
    setSaveError('');
    setSuccess('');
    try {
      await deleteFoodLog(id);
      setLogs((current) => current.filter((log) => log.id !== id));
      setSuccess(t('foodDeleted'));
    } catch (error) {
      setSaveError(`${t('foodDeleteError')} ${error.message}`);
    } finally {
      setDeletingId('');
    }
  }

  return (
    <div className="client-feature-grid">
      <form className="panel food-form" onSubmit={handleAdd}>
        <div className="panel-heading"><div><span className="eyebrow">{t('foodTab')}</span><h3>{t('foodTitle')}</h3></div></div>
        <div className="form-grid">
          <label className="form-label">{t('foodDate')}<input className="field" type="date" value={selectedDate} max={today} onChange={(event) => event.target.value && setSelectedDate(event.target.value)} required /></label>
          <label className="form-label">{t('mealType')}
            <select className="field" value={entry.meal_type} onChange={(event) => updateEntry('meal_type', event.target.value)}>
              {MEAL_TYPES.map((meal) => <option key={meal} value={meal}>{t(MEAL_LABELS[meal])}</option>)}
            </select>
          </label>
        </div>
        <div className="food-search">
          <label className="form-label">{t('foodSearchLabel')}
            <input className="field" type="search" maxLength={80} value={searchText} placeholder={t('foodSearchPlaceholder')} onChange={(event) => setSearchText(event.target.value)} />
          </label>
          <small className="muted-copy">{t('foodSearchHint')}</small>
          {searchState === 'loading' && <div className="empty-state" role="status">{t('foodSearching')}</div>}
          {searchState === 'error' && <div className="notice notice-error" role="alert">{t(searchStatus === 504 ? 'foodSearchTimeout' : searchStatus === 429 ? 'foodSearchBusy' : 'foodSearchUnavailable')}</div>}
          {searchState === 'done' && results.length === 0 && <div className="notice notice-info" role="status">{t('foodSearchNoResults')}</div>}
          {searchState === 'done' && results.length > 0 && (
            <ul className="food-search-results">
              {results.map((food, index) => (
                <li key={`${food.code}-${index}`}>
                  <button type="button" className="food-search-result" onClick={() => chooseFood(food)}>
                    <strong>{food.name}</strong>
                    <small>{[food.brand, `${food.per100g.calories} ${t('kcal')} / 100 ${t('foodGramsUnit')}`].filter(Boolean).join(' · ')}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selectedFood && (
            <div className="food-portion">
              <label className="form-label">{t('foodPortionGrams')}
                <input className="field" type="number" inputMode="decimal" min="1" max={MAX_PORTION_GRAMS} step="1" value={grams} onChange={(event) => changeGrams(event.target.value)} />
              </label>
              <small className="muted-copy">{t('foodPortionHint')}</small>
              <button className="text-action" type="button" onClick={clearSearch}>{t('foodSearchClear')}</button>
            </div>
          )}
        </div>
        <label className="form-label">{t('foodName')}<input className="field" maxLength={160} value={entry.food_name} onChange={(event) => updateEntry('food_name', event.target.value)} required /></label>
        <label className="form-label">{t('foodIngredients')}<textarea className="field intake-textarea" maxLength={1000} value={entry.ingredients} onChange={(event) => updateEntry('ingredients', event.target.value)} /></label>
        <div className="food-macro-grid">
          <label className="form-label">{t('foodCalories')}<input className="field" type="number" min="0" max="10000" step="0.1" value={entry.calories} onChange={(event) => updateEntry('calories', event.target.value)} required /></label>
          <label className="form-label">{t('foodProtein')}<input className="field" type="number" min="0" max="1000" step="0.1" value={entry.protein_g} onChange={(event) => updateEntry('protein_g', event.target.value)} /></label>
          <label className="form-label">{t('foodCarbs')}<input className="field" type="number" min="0" max="1000" step="0.1" value={entry.carbs_g} onChange={(event) => updateEntry('carbs_g', event.target.value)} /></label>
          <label className="form-label">{t('foodFat')}<input className="field" type="number" min="0" max="1000" step="0.1" value={entry.fat_g} onChange={(event) => updateEntry('fat_g', event.target.value)} /></label>
        </div>
        {saveError && <div className="notice notice-error" role="alert">{saveError}</div>}
        {success && <div className="notice notice-info" role="status">{success}</div>}
        <Button variant="primary" type="submit" disabled={saving}>{saving ? t('foodAdding') : t('foodAdd')}</Button>
      </form>

      <section className="panel food-day">
        <div className="panel-heading"><div><span className="eyebrow">{t('foodTab')}</span><h3>{t('foodDayTotals')} · {selectedDate}</h3></div></div>
        <dl className="food-totals">
          <div><dt>{t('foodCalories')}</dt><dd>{totals.calories.toLocaleString()}</dd></div>
          <div><dt>{t('foodProtein')}</dt><dd>{totals.protein_g}</dd></div>
          <div><dt>{t('foodCarbs')}</dt><dd>{totals.carbs_g}</dd></div>
          <div><dt>{t('foodFat')}</dt><dd>{totals.fat_g}</dd></div>
        </dl>
        {loadError && <div className="notice notice-error" role="alert">{t('foodLoadError')} {loadError}</div>}
        {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!loading && !loadError && dayLogs.length === 0 && <div className="empty-state">{t('foodNoEntries')}</div>}
        {dayLogs.length > 0 && MEAL_TYPES.map((meal) => {
          const mealLogs = dayLogs.filter((log) => log.meal_type === meal);
          if (mealLogs.length === 0) return null;
          return (
            <div className="food-meal" key={meal}>
              <h4>{t(MEAL_LABELS[meal])}</h4>
              {mealLogs.map((log) => (
                <article className="food-entry" key={log.id}>
                  <div>
                    <strong>{log.food_name}</strong>
                    {log.ingredients && <p className="muted-copy">{log.ingredients}</p>}
                    <small>
                      {log.calories} {t('kcal')}
                      {log.protein_g !== null && ` · ${t('foodProtein')}: ${log.protein_g}`}
                      {log.carbs_g !== null && ` · ${t('foodCarbs')}: ${log.carbs_g}`}
                      {log.fat_g !== null && ` · ${t('foodFat')}: ${log.fat_g}`}
                    </small>
                  </div>
                  <button className="text-action" type="button" disabled={deletingId === log.id} onClick={() => handleDelete(log.id)}>{t('foodDelete')}</button>
                </article>
              ))}
            </div>
          );
        })}
        {!loadError && (
          <div className="habit-week-chart">
            <h4>{t('foodWeek')} ({t('kcal')})</h4>
            <div className="habit-week-bars">
              {week.map((day) => (
                <div className="habit-week-bar" key={day.date} title={`${day.date}: ${day.calories} ${t('kcal')}`}>
                  <div className="habit-week-track"><span className="progress-amber" style={{ height: `${Math.round((day.calories / weekMax) * 100)}%` }} /></div>
                  <small>{day.weekday}</small>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
