import { useMemo, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { searchLocalFoods } from '../services/localFoodSearch.js';
import { foodFromManual, foodFromSearch } from '../services/mealPlanUtils.js';

const EMPTY_MANUAL = { name: '', grams: '100', calories: '', protein_g: '', carbs_g: '', fat_g: '' };

// Finds a food in the built-in list of 1,200+ foods (Arabic or English, per 100 g) or takes one typed in by hand, and
// hands it back with its amount in grams and its calories and macros worked out.
export default function FoodPicker({ onPick, onClose }) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(false);
  const [form, setForm] = useState(EMPTY_MANUAL);
  const [errors, setErrors] = useState({});
  const results = useMemo(() => searchLocalFoods(query, { locale, limit: 8 }), [query, locale]);

  function submitManual(event) {
    event.preventDefault();
    const { errors: found, food } = foodFromManual(form);
    setErrors(found);
    if (food) onPick(food);
  }

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const error = (key) => errors[key] && <small className="field-error">{t(errors[key])}</small>;

  return (
    <div className="food-picker">
      <div className="food-picker-bar">
        <input className="field" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('mpSearchPlaceholder')} aria-label={t('mpSearchPlaceholder')} autoFocus dir="auto" />
        <button type="button" className="text-action" onClick={() => setManual((value) => !value)}>{t(manual ? 'mpBackToSearch' : 'mpManualEntry')}</button>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('hbClose')}>{'\u2715'}</button>
      </div>
      {!manual && query.trim().length >= 2 && results.length === 0 && <p className="muted-copy">{t('mpNoResults')}</p>}
      {!manual && results.length > 0 && (
        <ul className="food-picker-results">
          {results.map((result) => (
            <li key={result.code}>
              <button type="button" onClick={() => onPick(foodFromSearch(result))}>
                <strong dir="auto">{result.name}</strong>
                <small dir="ltr">{result.per100g.calories} kcal · P {result.per100g.protein_g} · C {result.per100g.carbs_g} · F {result.per100g.fat_g} / 100 g</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {manual && (
        <form className="food-picker-manual" onSubmit={submitManual} noValidate>
          <label className="form-label">{t('mpFoodName')}<input className="field" value={form.name} onChange={set('name')} maxLength={160} dir="auto" />{error('name')}</label>
          <div className="food-picker-manual-grid">
            <label className="form-label">{t('mpGrams')}<input className="field" type="number" inputMode="decimal" min="1" value={form.grams} onChange={set('grams')} />{error('grams')}</label>
            <label className="form-label">{t('foodCalories')}<input className="field" type="number" inputMode="decimal" min="0" value={form.calories} onChange={set('calories')} />{error('calories')}</label>
            <label className="form-label">{t('foodProtein')}<input className="field" type="number" inputMode="decimal" min="0" value={form.protein_g} onChange={set('protein_g')} />{error('protein_g')}</label>
            <label className="form-label">{t('foodCarbs')}<input className="field" type="number" inputMode="decimal" min="0" value={form.carbs_g} onChange={set('carbs_g')} />{error('carbs_g')}</label>
            <label className="form-label">{t('foodFat')}<input className="field" type="number" inputMode="decimal" min="0" value={form.fat_g} onChange={set('fat_g')} />{error('fat_g')}</label>
          </div>
          <p className="muted-copy">{t('mpManualHelp')}</p>
          <Button variant="secondary" size="small" type="submit">{t('mpAddFood')}</Button>
        </form>
      )}
    </div>
  );
}