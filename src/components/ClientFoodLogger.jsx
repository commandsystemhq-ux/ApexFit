import { useEffect, useMemo, useRef, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { addFoodLog, deleteFoodLog, listFoodLogs, updateFoodLog } from '../services/clientFoodService.js';
import { MACRO_FIELDS, basisFromValues, entryToForm, joinPortion } from '../services/foodFormUtils.js';
import { MEAL_TYPES, summarizeFoodDay } from '../services/clientPriority2Utils.js';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { searchFoodDatabase } from '../services/foodSearchService.js';
import { MAX_PORTION_GRAMS, classifyFoodQuery, createDebouncer, defaultPortionGrams, parsePortionGrams, scaleFoodPortion } from '../services/foodSearchUtils.js';
import { mergeFoodResults, searchLocalFoods } from '../services/localFoodSearch.js';

const MEAL_LABELS = { breakfast: 'mealBreakfast', lunch: 'mealLunch', dinner: 'mealDinner', snack: 'mealSnack' };
const EMPTY_ENTRY = { meal_type: 'breakfast', food_name: '', ingredients: '', calories: '', protein_g: '', carbs_g: '', fat_g: '' };

export default function ClientFoodLogger() {
  const { locale, t } = useLocale();
  const today = getLocalDateString();
  const [selectedDate, setSelectedDate] = useState(today);
  const [entry, setEntry] = useState(EMPTY_ENTRY);
  const [grams, setGrams] = useState('');
  // Values per 100 g that the amount scales. It comes from a chosen food or from the person's own numbers.
  const [basis, setBasis] = useState(null);
  const [brand, setBrand] = useState('');
  const [editingId, setEditingId] = useState('');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [remote, setRemote] = useState({ state: 'idle', items: [], status: 0 });
  const formRef = useRef(null);
  const gramsRef = useRef(null);
  const caloriesRef = useRef(null);

  // Common foods answer at once and need no network.
  const localResults = useMemo(() => searchLocalFoods(searchText, { locale }), [searchText, locale]);
  const results = useMemo(() => mergeFoodResults(localResults, remote.items), [localResults, remote.items]);
  const typed = searchText.trim();

  // Open Food Facts adds products after a short pause. Any failure leaves the local results and manual entry as they are.
  useEffect(() => {
    const query = classifyFoodQuery(searchText, locale);
    if (!query) {
      setRemote({ state: 'idle', items: [], status: 0 });
      return undefined;
    }
    const controller = new AbortController();
    const debouncer = createDebouncer();
    setRemote((current) => ({ ...current, state: 'loading' }));
    debouncer.schedule(async () => {
      try {
        const items = await searchFoodDatabase(query, { signal: controller.signal });
        setRemote({ state: 'done', items, status: 0 });
      } catch (error) {
        if (controller.signal.aborted) return;
        setRemote({ state: 'error', items: [], status: error.status || 0 });
      }
    });
    return () => {
      debouncer.cancel();
      controller.abort();
    };
  }, [searchText, locale]);

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

  function resetForm() {
    setEntry((current) => ({ ...EMPTY_ENTRY, meal_type: current.meal_type }));
    setGrams('');
    setBasis(null);
    setBrand('');
    setEditingId('');
  }

  function goToForm(focusRef) {
    window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      focusRef?.current?.focus({ preventScroll: true });
    });
  }

  function updateField(field, value) {
    setSuccess('');
    const next = { ...entry, [field]: value };
    setEntry(next);
    // Typing your own numbers makes them the new base, so changing the amount afterwards scales them.
    if (MACRO_FIELDS.includes(field)) setBasis(basisFromValues(next, grams));
  }

  function applyPortion(source, amount) {
    const scaled = scaleFoodPortion(source, amount);
    if (!scaled) return;
    setEntry((current) => ({
      ...current,
      calories: String(scaled.calories),
      protein_g: String(scaled.protein_g),
      carbs_g: String(scaled.carbs_g),
      fat_g: String(scaled.fat_g),
    }));
  }

  function changeGrams(value) {
    setSuccess('');
    const hadGrams = parsePortionGrams(grams) !== null;
    setGrams(value);
    if (basis) {
      applyPortion(basis, value);
    } else if (!hadGrams && parsePortionGrams(value) !== null) {
      // The numbers were typed for this first amount; from now on the amount scales them.
      setBasis(basisFromValues(entry, value));
    }
  }

  // Choosing a result fills the form below. Nothing is saved until the person presses the button there.
  function chooseFood(food) {
    const amount = String(defaultPortionGrams(food));
    setSuccess('');
    setSaveError('');
    setEditingId('');
    setBasis(food.per100g);
    setBrand(food.brand || '');
    setGrams(amount);
    setEntry((current) => ({ ...current, food_name: food.name, ingredients: '' }));
    applyPortion(food.per100g, amount);
    setSearchText('');
    goToForm(gramsRef);
  }

  // Any word can become a meal: the name moves to the form and the numbers are typed by hand.
  function quickAdd() {
    const name = typed.slice(0, 160);
    if (!name) return;
    setSuccess('');
    setSaveError('');
    setEditingId('');
    setBasis(null);
    setBrand('');
    setGrams('');
    setEntry((current) => ({ ...EMPTY_ENTRY, meal_type: current.meal_type, food_name: name }));
    setSearchText('');
    goToForm(caloriesRef);
  }

  function startEdit(log) {
    const form = entryToForm(log);
    setSuccess('');
    setSaveError('');
    setSearchText('');
    setEditingId(log.id);
    setEntry(form.entry);
    setGrams(form.grams);
    setBasis(basisFromValues(form.entry, form.grams));
    setBrand('');
    goToForm();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSaveError('');
    setSuccess('');
    setSaving(true);
    try {
      const notes = [brand, entry.ingredients].filter(Boolean).join(' · ');
      const payload = { ...entry, ingredients: joinPortion({ grams, unit: t('foodGramsUnit'), notes }) };
      if (editingId) {
        await updateFoodLog(editingId, payload);
        setSuccess(t('foodUpdated'));
      } else {
        await addFoodLog({ loggedOn: selectedDate, ...payload });
        setSuccess(t('foodAdded'));
      }
      resetForm();
      await refresh();
    } catch (error) {
      setSaveError(`${t(editingId ? 'foodUpdateError' : 'foodSaveError')} ${error.message}`);
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
      if (editingId === id) resetForm();
      setSuccess(t('foodDeleted'));
    } catch (error) {
      setSaveError(`${t('foodDeleteError')} ${error.message}`);
    } finally {
      setDeletingId('');
    }
  }

  const remoteNotice = remote.state === 'error' ? t(remote.status === 504 ? 'foodSearchTimeout' : remote.status === 429 ? 'foodSearchBusy' : 'foodSearchUnavailable') : '';

  return (
    <div className="client-feature-grid food-grid">
      <form className="panel food-form" onSubmit={handleSubmit} ref={formRef}>
        <div className="panel-heading"><div><span className="eyebrow">{t('foodTab')}</span><h3>{editingId ? t('foodEditTitle') : t('foodTitle')}</h3></div></div>

        <div className="food-search">
          <label className="form-label">{t('foodSearchLabel')}
            <input className="field" type="search" maxLength={80} value={searchText} placeholder={t('foodSearchPlaceholder')} autoComplete="off" onChange={(event) => setSearchText(event.target.value)} />
          </label>
          <small className="muted-copy">{t('foodSearchHint')}</small>

          {results.length > 0 && (
            <ul className="food-search-results">
              {results.map((food, index) => (
                <li key={`${food.code}-${index}`}>
                  <button type="button" className="food-search-result" onClick={() => chooseFood(food)}>
                    <span className="food-result-top">
                      <strong dir="auto">{food.name}</strong>
                      <span className={`food-source ${food.source === 'local' ? 'is-local' : ''}`}>{t(food.source === 'local' ? 'foodSourceLocal' : 'foodSourceOff')}</span>
                    </span>
                    <small>{[food.brand, `${food.per100g.calories} ${t('kcal')} · ${t('foodProtein')} ${food.per100g.protein_g} · ${t('foodCarbs')} ${food.per100g.carbs_g} · ${t('foodFat')} ${food.per100g.fat_g} / 100 ${t('foodGramsUnit')}`].filter(Boolean).join(' · ')}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {remote.state === 'loading' && <div className="empty-state" role="status">{t('foodSearching')}</div>}
          {remoteNotice && <div className="notice notice-info" role="status">{remoteNotice}</div>}
          {typed.length >= 2 && remote.state === 'done' && results.length === 0 && <div className="notice notice-info" role="status">{t('foodSearchNoResults')}</div>}
          {typed && (
            <button type="button" className="food-quick-add" onClick={quickAdd}>
              <span aria-hidden="true">➕</span> <span dir="auto">{t('foodQuickAdd').replace('{name}', typed)}</span>
            </button>
          )}
        </div>

        <div className="food-details">
          <h4>{t('foodDetailsTitle')}</h4>
          {editingId && <div className="notice notice-info" role="status">{t('foodEditing')}</div>}
          <div className="form-grid">
            <label className="form-label">{t('foodDate')}<input className="field" type="date" value={selectedDate} max={today} disabled={Boolean(editingId)} onChange={(event) => event.target.value && setSelectedDate(event.target.value)} required /></label>
            <label className="form-label">{t('mealType')}
              <select className="field" value={entry.meal_type} onChange={(event) => updateField('meal_type', event.target.value)}>
                {MEAL_TYPES.map((meal) => <option key={meal} value={meal}>{t(MEAL_LABELS[meal])}</option>)}
              </select>
            </label>
          </div>
          <label className="form-label">{t('foodName')}<input className="field" maxLength={160} dir="auto" value={entry.food_name} onChange={(event) => updateField('food_name', event.target.value)} required /></label>
          <label className="form-label">{t('foodPortionGrams')}
            <input ref={gramsRef} className="field" type="number" inputMode="decimal" min="1" max={MAX_PORTION_GRAMS} step="1" value={grams} onChange={(event) => changeGrams(event.target.value)} />
          </label>
          <small className="muted-copy">{basis ? t('foodPortionHint') : t('foodPortionManualHint')}</small>
          <div className="food-macro-grid">
            <label className="form-label">{t('foodCalories')}<input ref={caloriesRef} className="field" type="number" inputMode="decimal" min="0" max="10000" step="0.1" value={entry.calories} onChange={(event) => updateField('calories', event.target.value)} required /></label>
            <label className="form-label">{t('foodProtein')}<input className="field" type="number" inputMode="decimal" min="0" max="1000" step="0.1" value={entry.protein_g} onChange={(event) => updateField('protein_g', event.target.value)} /></label>
            <label className="form-label">{t('foodCarbs')}<input className="field" type="number" inputMode="decimal" min="0" max="1000" step="0.1" value={entry.carbs_g} onChange={(event) => updateField('carbs_g', event.target.value)} /></label>
            <label className="form-label">{t('foodFat')}<input className="field" type="number" inputMode="decimal" min="0" max="1000" step="0.1" value={entry.fat_g} onChange={(event) => updateField('fat_g', event.target.value)} /></label>
          </div>
          <label className="form-label">{t('foodNotes')}<textarea className="field intake-textarea" maxLength={900} dir="auto" value={entry.ingredients} onChange={(event) => updateField('ingredients', event.target.value)} /></label>
        </div>

        {saveError && <div className="notice notice-error" role="alert">{saveError}</div>}
        {success && <div className="notice notice-info" role="status">{success}</div>}
        <div className="food-form-actions">
          <Button variant="primary" type="submit" disabled={saving}>{saving ? t(editingId ? 'foodSaving' : 'foodAdding') : t(editingId ? 'foodSave' : 'foodAdd')}</Button>
          {(editingId || entry.food_name || entry.calories) && <Button variant="secondary" type="button" onClick={resetForm}>{t(editingId ? 'foodCancelEdit' : 'foodClearForm')}</Button>}
        </div>
      </form>

      <section className="panel food-day">
        <div className="panel-heading"><div><span className="eyebrow">{t('foodTab')}</span><h3 className="food-day-title">{t('foodDayTotals')} <bdi dir="ltr">· {selectedDate}</bdi></h3></div></div>
        <dl className="food-totals">
          <div><dt>{t('foodCalories')}</dt><dd>{totals.calories.toLocaleString(locale)}</dd></div>
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
                <article className={`food-entry ${editingId === log.id ? 'is-editing' : ''}`} key={log.id}>
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
                  <div className="food-entry-actions">
                    <button className="text-action" type="button" onClick={() => startEdit(log)}>{t('foodEdit')}</button>
                    <button className="text-action" type="button" disabled={deletingId === log.id} onClick={() => handleDelete(log.id)}>{t('foodDelete')}</button>
                  </div>
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
