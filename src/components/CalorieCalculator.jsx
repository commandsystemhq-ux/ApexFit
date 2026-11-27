import { useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import {
  ACTIVITY_LEVELS, ADJUSTMENT_LIMITS, DEFAULT_ADJUSTMENT, FORMULAS, GOALS, MACRO_SPLITS,
  ageFromBirthDate, calculate, goalFromIntake, validateCalculatorInput,
} from '../services/calorieCalculator.js';
import { applyToClientGoal, getCalculatorData, saveCalculatorProfile } from '../services/calorieCalculatorService.js';

function initialForm(data) {
  const goal = data.goal || goalFromIntake(data.intake_goal);
  const age = ageFromBirthDate(data.birth_date);
  return {
    sex: data.sex || '',
    birthDate: data.birth_date || '',
    age: age === null ? '' : String(age),
    heightCm: data.height_cm ?? '',
    weightKg: data.weight_kg ?? '',
    bodyFatPct: data.body_fat_pct ?? '',
    activity: data.activity_level || 'moderate',
    goal,
    formula: data.formula || 'mifflin',
    split: 'goal',
    adjustmentPct: String(DEFAULT_ADJUSTMENT[goal]),
    customProtein: '30',
    customCarbs: '40',
    customFat: '30',
  };
}

function Field({ label, hint, error, t, children }) {
  return (
    <label className="form-label">
      {label}
      {children}
      {hint && <small className="muted-copy">{hint}</small>}
      {error && <small className="field-error" role="alert">{t(error)}</small>}
    </label>
  );
}

// BMR / TDEE calculator for one client. It starts from what is already known about them (latest weight and body fat,
// height, remembered sex and birth date), and "Apply" writes the result as the client's daily goal.
export default function CalorieCalculator({ clientId, onApplied }) {
  const { t, locale } = useLocale();
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [form, setForm] = useState(null);
  const [saveProfile, setSaveProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [currentTarget, setCurrentTarget] = useState(null);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: '' });
    setNotice(null);
    getCalculatorData(clientId)
      .then((data) => {
        if (!active) return;
        setState({ status: 'ready', data, error: '' });
        setForm(initialForm(data));
        setCurrentTarget(data.target);
      })
      .catch((error) => active && setState({ status: 'error', data: null, error: error.message }));
    return () => { active = false; };
  }, [clientId]);

  const check = useMemo(() => (form ? validateCalculatorInput(form) : null), [form]);
  const result = useMemo(() => (check?.ok ? calculate(check.values) : null), [check]);

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{t('ccLoadError')} {state.error}</div>;

  const { data } = state;
  const set = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const errorOf = (field, raw) => (String(raw ?? '').trim() !== '' || field === 'formula' ? check.errors[field] : undefined);
  const date = (value) => new Date(`${value}T12:00:00`).toLocaleDateString(locale);

  function changeBirthDate(value) {
    const age = ageFromBirthDate(value);
    setForm((current) => ({ ...current, birthDate: value, age: age === null ? current.age : String(age) }));
  }

  function changeGoal(goal) {
    setForm((current) => ({ ...current, goal, adjustmentPct: String(DEFAULT_ADJUSTMENT[goal]) }));
  }

  async function apply() {
    if (!result) return;
    setBusy(true);
    setNotice(null);
    try {
      await applyToClientGoal(clientId, result.payload);
      setCurrentTarget({ calories: result.payload.calories, protein_g: result.payload.protein, carbs_g: result.payload.carbs, fats_g: result.payload.fats });
      if (saveProfile) {
        await saveCalculatorProfile(clientId, {
          sex: form.sex,
          birthDate: form.birthDate,
          heightCm: check.values.heightCm,
          activity: form.activity,
          goal: form.goal,
          formula: form.formula,
        }).catch(() => {});
      }
      setNotice({ kind: 'info', text: fillText(t('ccApplied'), { calories: result.payload.calories }) });
      onApplied?.(result.payload);
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('ccApplyError')} ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  const missing = [
    !form.sex && t('ccSex'),
    !form.age && t('ccAge'),
    !form.heightCm && t('ccHeight'),
    !form.weightKg && t('ccWeight'),
  ].filter(Boolean);

  return (
    <div className="calorie-calculator">
      <p className="muted-copy">{t('ccIntro')}</p>
      {currentTarget && (
        <p className="calc-current" dir="auto">
          {fillText(t('ccCurrentTarget'), { calories: currentTarget.calories ?? '—', protein: currentTarget.protein_g ?? '—', carbs: currentTarget.carbs_g ?? '—', fats: currentTarget.fats_g ?? '—' })}
        </p>
      )}
      {missing.length > 0 && <p className="muted-copy">{fillText(t('ccMissing'), { fields: missing.join(', ') })}</p>}

      <div className="form-grid calc-grid">
        <Field t={t} label={t('ccSex')} error={errorOf('sex', form.sex)}>
          <select className="field" value={form.sex} onChange={(event) => set('sex', event.target.value)}>
            <option value="">{t('ccChoose')}</option>
            <option value="male">{t('ccMale')}</option>
            <option value="female">{t('ccFemale')}</option>
          </select>
        </Field>
        <Field t={t} label={t('ccBirthDate')}>
          <input className="field" type="date" value={form.birthDate} max={new Date().toISOString().slice(0, 10)} onChange={(event) => changeBirthDate(event.target.value)} />
        </Field>
        <Field t={t} label={t('ccAge')} error={errorOf('age', form.age)}>
          <input className="field" inputMode="decimal" dir="ltr" value={form.age} onChange={(event) => set('age', event.target.value)} />
        </Field>
        <Field t={t} label={t('ccHeight')} error={errorOf('heightCm', form.heightCm)} hint={data.height_source === 'intake' && String(form.heightCm) === String(data.height_cm) ? t('ccFromIntake') : undefined}>
          <input className="field" inputMode="decimal" dir="ltr" value={form.heightCm} onChange={(event) => set('heightCm', event.target.value)} />
        </Field>
        <Field t={t} label={t('ccWeight')} error={errorOf('weightKg', form.weightKg)} hint={data.weight_date && String(form.weightKg) === String(data.weight_kg) ? fillText(t('ccFromMeasurement'), { date: date(data.weight_date) }) : undefined}>
          <input className="field" inputMode="decimal" dir="ltr" value={form.weightKg} onChange={(event) => set('weightKg', event.target.value)} />
        </Field>
        <Field t={t} label={t('ccBodyFat')} error={errorOf('bodyFatPct', form.bodyFatPct)} hint={data.body_fat_date && String(form.bodyFatPct) === String(data.body_fat_pct) ? fillText(t('ccFromMeasurement'), { date: date(data.body_fat_date) }) : t('ccBodyFatOptional')}>
          <input className="field" inputMode="decimal" dir="ltr" value={form.bodyFatPct} onChange={(event) => set('bodyFatPct', event.target.value)} />
        </Field>
        <Field t={t} label={t('ccFormula')} error={errorOf('formula', form.formula) || (form.formula === 'katch' ? check.errors.bodyFatPct && 'ccErr_katchNeedsFat' : undefined)}>
          <select className="field" value={form.formula} onChange={(event) => set('formula', event.target.value)}>
            {FORMULAS.map((value) => <option key={value} value={value}>{t(`ccFormula_${value}`)}</option>)}
          </select>
        </Field>
        <Field t={t} label={t('ccActivity')}>
          <select className="field" value={form.activity} onChange={(event) => set('activity', event.target.value)}>
            {ACTIVITY_LEVELS.map((value) => <option key={value} value={value}>{t(`ccActivity_${value}`)}</option>)}
          </select>
        </Field>
        <Field t={t} label={t('ccGoal')}>
          <select className="field" value={form.goal} onChange={(event) => changeGoal(event.target.value)}>
            {GOALS.map((value) => <option key={value} value={value}>{t(`ccGoal_${value}`)}</option>)}
          </select>
        </Field>
        <Field t={t} label={t('ccAdjust')} error={errorOf('adjustmentPct', form.adjustmentPct)} hint={fillText(t('ccAdjustHint'), { min: ADJUSTMENT_LIMITS.min, max: ADJUSTMENT_LIMITS.max })}>
          <input className="field" inputMode="decimal" dir="ltr" value={form.adjustmentPct} onChange={(event) => set('adjustmentPct', event.target.value)} />
        </Field>
        <Field t={t} label={t('ccSplit')} error={errorOf('split', form.split)}>
          <select className="field" value={form.split} onChange={(event) => set('split', event.target.value)}>
            {MACRO_SPLITS.map((value) => <option key={value} value={value}>{t(`ccSplit_${value}`)}</option>)}
          </select>
        </Field>
      </div>

      {form.split === 'custom' && (
        <div className="form-grid calc-grid">
          <Field t={t} label={`${t('foodProtein')} %`}><input className="field" inputMode="decimal" dir="ltr" value={form.customProtein} onChange={(event) => set('customProtein', event.target.value)} /></Field>
          <Field t={t} label={`${t('foodCarbs')} %`}><input className="field" inputMode="decimal" dir="ltr" value={form.customCarbs} onChange={(event) => set('customCarbs', event.target.value)} /></Field>
          <Field t={t} label={`${t('foodFat')} %`}><input className="field" inputMode="decimal" dir="ltr" value={form.customFat} onChange={(event) => set('customFat', event.target.value)} /></Field>
        </div>
      )}

      <section className="calc-results" aria-live="polite">
        <h4>{t('ccResults')}</h4>
        {!result && <p className="muted-copy">{t('ccFillIn')}</p>}
        {result && (
          <>
            <div className="calc-stats">
              <div><small>{t('ccBmr')}</small><strong dir="ltr">{result.bmr}</strong></div>
              <div><small>{t('ccTdee')}</small><strong dir="ltr">{result.tdee}</strong></div>
              <div className="calc-target"><small>{t('ccTarget')}</small><strong dir="ltr">{result.calories} {t('kcal')}</strong></div>
            </div>
            {result.floored && <p className="notice notice-info">{fillText(t('ccFloored'), { min: result.minCalories })}</p>}
            <div className="calc-macros">
              {[['foodProtein', 'protein'], ['foodCarbs', 'carbs'], ['foodFat', 'fat']].map(([labelKey, key]) => (
                <div key={key}><small>{t(labelKey)}</small><strong dir="ltr">{result.macros.grams[key]} g</strong><span dir="ltr">{result.macros.percent[key]}%</span></div>
              ))}
            </div>
            <details className="calc-compare">
              <summary>{t('ccCompare')}</summary>
              <ul>
                {FORMULAS.map((formula) => (
                  <li key={formula} className={formula === form.formula ? 'is-selected' : ''}>
                    <span>{t(`ccFormula_${formula}`)}</span>
                    <strong dir="ltr">{result.bmrs[formula] === null ? t('ccNeedsBodyFat') : `${result.bmrs[formula]} ${t('kcal')}`}</strong>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      <label className="checkbox-row"><input type="checkbox" checked={saveProfile} onChange={(event) => setSaveProfile(event.target.checked)} />{t('ccSaveProfile')}</label>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      <Button variant="primary" type="button" disabled={!result || busy} onClick={apply}>{busy ? t('ccApplying') : t('ccApply')}</Button>
      <p className="muted-copy">{t('ccDisclaimer')}</p>
    </div>
  );
}
