import { useCallback, useEffect, useRef, useState } from 'react';
import Button from './Button.jsx';
import { NutritionSummaryView, ProgressBar } from './NutritionViews.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { importErrorKey, countSkipReasons, SKIP_REASON_KEYS, dayProgress, emptyNutritionForm, mergeNutritionByDay, nutritionFormFromDay, targetsToForm, validateNutritionForm, validateTargetsForm } from '../services/healthUtils.js';
import { parseMyFitnessPalCsv, readTextFile } from '../services/healthImport.js';
import { deleteNutritionLog, getHealthOverview, importNutritionLogs, saveNutritionLog, setMyNutritionTargets } from '../services/healthService.js';

const FORM_FIELDS = [
  { key: 'calories', labelKey: 'nutCalories', step: '1' },
  { key: 'protein', labelKey: 'nutProtein', step: '0.1' },
  { key: 'carbs', labelKey: 'nutCarbs', step: '0.1' },
  { key: 'fats', labelKey: 'nutFats', step: '0.1' },
];

// MyFitnessPal import, daily macros typed by hand, the goal and progress bars. Lives on the Integrations and Food pages.
export default function NutritionTracker() {
  const { t } = useLocale();
  const today = getLocalDateString();
  const fileInput = useRef(null);
  const [overview, setOverview] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [date, setDate] = useState(today);
  const [form, setForm] = useState(emptyNutritionForm(today));
  const [errors, setErrors] = useState({});
  const [targetsForm, setTargetsForm] = useState(targetsToForm(null));
  const [targetErrors, setTargetErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getHealthOverview(null, 8);
      setOverview(data);
      setTargetsForm(targetsToForm(data.nutrition.targets));
      setLoadError('');
      return data;
    } catch (error) {
      setLoadError(error.message);
      return null;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const logs = overview?.nutrition.logs || [];
  const targets = overview?.nutrition.targets || null;
  const byDay = mergeNutritionByDay(logs);
  const selectedDay = byDay.get(date) || null;
  const progress = dayProgress(selectedDay, targets);
  const hasManual = logs.some((log) => log.log_date === date && log.source === 'manual');

  // The form follows the chosen day (and the data once it has loaded).
  useEffect(() => {
    setForm(nutritionFormFromDay(byDay.get(date) || null, date));
    setErrors({});
  }, [date, overview]);

  const report = (kind, text) => setNotice({ kind, text });

  async function saveDay(event) {
    event.preventDefault();
    const result = validateNutritionForm({ ...form, date }, today);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy('save');
    try {
      await saveNutritionLog(result.payload);
      await load();
      report('info', t('nutSaved'));
    } catch (error) {
      report('error', `${t('nutSaveError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function removeManual() {
    setBusy('delete');
    try {
      await deleteNutritionLog(date, 'manual');
      await load();
      report('info', t('nutDeleted'));
    } catch (error) {
      report('error', `${t('nutSaveError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function saveTargets(event) {
    event.preventDefault();
    const result = validateTargetsForm(targetsForm);
    setTargetErrors(result.errors);
    if (!result.valid) return;
    setBusy('targets');
    try {
      await setMyNutritionTargets(result.payload);
      await load();
      report('info', t('nutTargetsSaved'));
    } catch (error) {
      report('error', `${t('nutSaveError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    setPreview(null);
    setBusy('read');
    try {
      const read = await readTextFile(file);
      const parsed = read.ok ? parseMyFitnessPalCsv(read.text, { today }) : read;
      if (!parsed.ok) report('error', t(importErrorKey(parsed.error)));
      else setPreview({ name: file.name, ...parsed });
    } catch (error) {
      report('error', `${t('hltImpFailed')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function runImport() {
    setBusy('import');
    try {
      const count = await importNutritionLogs(preview.days);
      setPreview(null);
      await load();
      report('info', `${t('nutImported')} ${count}`);
    } catch (error) {
      report('error', `${t('nutImportError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  const skipCounts = preview ? countSkipReasons(preview.skipped) : {};
  const recent = Array.from(byDay.values()).sort((left, right) => right.log_date.localeCompare(left.log_date)).slice(0, 7);

  return (
    <div className="nutrition-tracker">
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {loadError && <div className="notice notice-error" role="alert">{t('nutLoadError')} {loadError}</div>}
      {!overview && !loadError && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}

      {overview && (
        <div className="client-feature-grid">
          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('nutTab')}</span><h3>{t('nutProgressTitle')}</h3></div></div>
            <label className="form-label">{t('foodDate')}
              <input className="field" type="date" value={date} max={today} onChange={(event) => event.target.value && setDate(event.target.value)} />
            </label>
            <ProgressBar label={t('nutCalories')} progress={progress.calories} unit={t('nutKcal')} />
            <ProgressBar label={t('nutProtein')} progress={progress.protein} unit="g" />
            <ProgressBar label={t('nutCarbs')} progress={progress.carbs} unit="g" />
            <ProgressBar label={t('nutFats')} progress={progress.fats} unit="g" />
            {selectedDay?.water_ml != null && <p className="muted-copy">{t('nutWater')}: <span dir="ltr">{selectedDay.water_ml.toLocaleString()} ml</span></p>}
            {selectedDay?.sources.length > 0 && (
              <p className="muted-copy">{t('nutSource')}: {selectedDay.sources.map((source) => t(`nutSource_${source}`)).join(', ')}</p>
            )}
            {!selectedDay && <p className="muted-copy">{t('nutNoLogsDay')}</p>}
          </section>

          <form className="panel" onSubmit={saveDay} noValidate>
            <div className="panel-heading"><div><span className="eyebrow">{t('nutTab')}</span><h3>{t('nutManualTitle')}</h3></div></div>
            <div className="food-macro-grid">
              {FORM_FIELDS.map((field) => (
                <label className="form-label" key={field.key}>{t(field.labelKey)}
                  <input className="field" type="number" inputMode="decimal" min="0" step={field.step} value={form[field.key]} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))} aria-invalid={Boolean(errors[field.key])} />
                  {errors[field.key] && <small className="field-error">{t(errors[field.key])}</small>}
                </label>
              ))}
              <label className="form-label">{t('nutWater')} (ml)
                <input className="field" type="number" inputMode="numeric" min="0" step="50" value={form.water} onChange={(event) => setForm((current) => ({ ...current, water: event.target.value }))} aria-invalid={Boolean(errors.water)} />
                {errors.water && <small className="field-error">{t(errors.water)}</small>}
              </label>
            </div>
            <label className="form-label">{t('nutNotes')}
              <textarea className="field intake-textarea" maxLength={500} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
              {errors.notes && <small className="field-error">{t(errors.notes)}</small>}
            </label>
            {(errors.form || errors.date) && <div className="notice notice-error" role="alert">{t(errors.form || errors.date)}</div>}
            <div className="template-actions">
              <Button variant="primary" type="submit" disabled={busy !== ''}>{busy === 'save' ? t('nutSaving') : t('nutSave')}</Button>
              {hasManual && <Button variant="secondary" type="button" onClick={removeManual} disabled={busy !== ''}>{t('nutDeleteManual')}</Button>}
            </div>
          </form>

          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">MyFitnessPal</span><h3>{t('nutImportTitle')}</h3></div></div>
            <p className="muted-copy">{t('nutImportHelp')}</p>
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" onChange={chooseFile} aria-label={t('nutImportChoose')} />
            <Button variant="secondary" type="button" onClick={() => fileInput.current?.click()} disabled={busy !== ''}>{busy === 'read' ? t('hltImpReading') : t('nutImportChoose')}</Button>
            {preview && (
              <div className="import-preview">
                <h4 dir="auto">{preview.name}</h4>
                <p>{t('nutImportFound')} <strong>{preview.days.length}</strong> {t('nutImportDays')} · <span dir="ltr">{preview.range.from} → {preview.range.to}</span></p>
                {Object.keys(skipCounts).length > 0 && (
                  <ul className="import-skipped">
                    {Object.entries(skipCounts).map(([reason, count]) => <li key={reason}>{t(SKIP_REASON_KEYS[reason] || 'nutSkipBadNumber')}: {count}</li>)}
                  </ul>
                )}
                <div className="template-actions">
                  <Button variant="primary" type="button" onClick={runImport} disabled={busy !== ''}>{busy === 'import' ? t('nutImporting') : t('nutImportRun')}</Button>
                  <Button variant="secondary" type="button" onClick={() => setPreview(null)} disabled={busy !== ''}>{t('nutCancel')}</Button>
                </div>
              </div>
            )}
          </section>

          <form className="panel" onSubmit={saveTargets} noValidate>
            <div className="panel-heading"><div><span className="eyebrow">{t('nutTab')}</span><h3>{t('nutTargetsTitle')}</h3></div></div>
            <p className="muted-copy">{t('nutTargetsHelp')}</p>
            <div className="food-macro-grid">
              {FORM_FIELDS.map((field) => (
                <label className="form-label" key={field.key}>{t(field.labelKey)}
                  <input className="field" type="number" inputMode="decimal" min="0" step={field.step} value={targetsForm[field.key]} onChange={(event) => setTargetsForm((current) => ({ ...current, [field.key]: event.target.value }))} aria-invalid={Boolean(targetErrors[field.key])} />
                  {targetErrors[field.key] && <small className="field-error">{t(targetErrors[field.key])}</small>}
                </label>
              ))}
            </div>
            <Button variant="primary" type="submit" disabled={busy !== ''}>{busy === 'targets' ? t('nutSaving') : t('nutTargetsSave')}</Button>
          </form>

          <section className="panel nutrition-week">
            <div className="panel-heading"><div><span className="eyebrow">{t('nutTab')}</span><h3>{t('nutWeekTitle')}</h3></div></div>
            <NutritionSummaryView logs={logs} targets={targets} today={today} />
            {recent.length > 0 && (
              <ul className="nutrition-recent">
                {recent.map((day) => (
                  <li key={day.log_date}>
                    <button type="button" className="text-action" onClick={() => setDate(day.log_date)}>{day.log_date}</button>
                    <span dir="ltr">{day.calories_consumed ?? '-'} {t('nutKcal')} · P {day.protein_g ?? '-'} · C {day.carbs_g ?? '-'} · F {day.fats_g ?? '-'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
