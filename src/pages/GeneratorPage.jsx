import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useExerciseBundle } from '../hooks/useExerciseBundle.js';
import { generateTrainingPlan } from '../services/aiService.js';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { displayName } from '../services/exerciseI18n.js';
import { BUILDER_HANDOFF_KEY } from '../services/workoutProgramService.js';
import { PAGES } from '../routes.js';

const GOALS = [['fat_loss', 'goalFatLoss'], ['muscle_gain', 'goalMuscleGain'], ['strength', 'goalStrength'], ['endurance', 'goalEndurance'], ['general_fitness', 'goalGeneralFitness']];
const LEVELS = ['beginner', 'intermediate', 'advanced'];

// Jack builds a full training plan from the request and saves it as a real program for the coach.
export default function GeneratorPage({ onNotify }) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const bundle = useExerciseBundle(locale);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [environment, setEnvironment] = useState('gym');
  const [clients, setClients] = useState([]);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({ clientId: '', goal: 'general_fitness', level: 'beginner', days: '3', limitations: '', notes: '', language: locale === 'ar' ? 'ar' : 'en' });

  useEffect(() => {
    let active = true;
    listMyClients().then((rows) => active && setClients(rows.filter((client) => client.status === 'active'))).catch(() => {});
    return () => { active = false; };
  }, []);

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const plan = await generateTrainingPlan({
        client_id: form.clientId || undefined,
        goal: form.goal,
        level: form.level,
        days: Number(form.days),
        environment,
        limitations: form.limitations,
        notes: form.notes,
        language: form.language,
        locale,
      });
      setResult(plan);
      onNotify?.(t('planGenerated'));
    } catch (generationError) {
      setError(generationError.message || t('jaGenerateError'));
    } finally {
      setLoading(false);
    }
  }

  function openInBuilder() {
    window.sessionStorage.setItem(BUILDER_HANDOFF_KEY, result.program_id);
    navigate(PAGES.workoutBuilder.path);
  }

  const exerciseName = (item) => displayName({ name: item.name, slug: item.slug }, locale, bundle) || item.name;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('generatorTitle')} description={t('generatorDescription')} />
      <div className="generator-layout">
        <form className="panel generator-form" onSubmit={handleGenerate}>
          <div className="generator-title"><span className="feature-icon">{'\u2726'}</span><div><h3>{t('planDetails')}</h3></div></div>
          <label className="form-label">{t('jaClientOptional')}
            <select className="field" name="clientId" value={form.clientId} onChange={updateField}>
              <option value="">{t('jaNoClient')}</option>
              {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
            </select>
          </label>
          <label className="form-label">{t('goal')}
            <select className="field" name="goal" value={form.goal} onChange={updateField}>{GOALS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select>
          </label>
          <label className="form-label">{t('jaLevel')}
            <select className="field" name="level" value={form.level} onChange={updateField}>{LEVELS.map((value) => <option key={value} value={value}>{t(`difficulty_${value}`)}</option>)}</select>
          </label>
          <label className="form-label">{t('trainingDays')}<select className="field" name="days" value={form.days} onChange={updateField}>{['1', '2', '3', '4', '5', '6', '7'].map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
          <fieldset className="environment-picker">
            <legend className="form-label">{t('environment')}</legend>
            {[['gym', 'fullGym'], ['home', 'home'], ['bodyweight', 'bodyweight']].map(([value, label]) => (
              <button key={value} className={`choice-chip ${environment === value ? 'is-selected' : ''}`} type="button" aria-pressed={environment === value} onClick={() => setEnvironment(value)}>{t(label)}</button>
            ))}
          </fieldset>
          <label className="form-label">{t('limitations')}<input className="field" name="limitations" value={form.limitations} onChange={updateField} maxLength={500} dir="auto" /></label>
          <label className="form-label">{t('jaNotes')}<input className="field" name="notes" value={form.notes} onChange={updateField} maxLength={500} placeholder={t('jaNotesPlaceholder')} dir="auto" /></label>
          <label className="form-label">{t('jaPlanLanguage')}
            <select className="field" name="language" value={form.language} onChange={updateField}><option value="ar">العربية</option><option value="en">English</option></select>
          </label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <Button variant="primary" type="submit" disabled={loading}>{loading ? t('preparing') : t('generate')}</Button>
        </form>

        <section className="panel plan-output" aria-live="polite">
          <div className="panel-heading"><div><span className="eyebrow">{t('generatorTitle')}</span><h3>{result ? result.title : t('planOutputTitle')}</h3></div></div>
          {!result && !loading && (
            <div className="dashboard-empty">
              <span className="feature-icon" aria-hidden="true">{'\u2726'}</span>
              <p>{t('planOutputDescription')}</p>
            </div>
          )}
          {loading && <div className="empty-state" role="status">{t('preparing')}</div>}
          {result && (
            <div className="generated-plan">
              <p className="generated-plan-source">
                <span className={`soft-badge ${result.source === 'ai' ? 'badge-blue' : 'badge-muted'}`}>{t(result.source === 'ai' ? 'jaSourceAi' : 'jaSourceRules')}</span>
                {' '}{t('jaSavedAs')}
              </p>
              {result.description && <p className="muted-copy" dir="auto" style={{ whiteSpace: 'pre-line' }}>{result.description}</p>}
              {result.days.map((day) => (
                <article className="generated-day" key={day.name}>
                  <h4 dir="auto">{day.name}</h4>
                  <ul>
                    {day.exercises.map((item, index) => (
                      <li key={`${item.exercise_id}-${index}`}><strong dir="auto">{exerciseName(item)}</strong> <span dir="ltr">{item.sets} × {item.reps} · {item.rest_seconds}s</span></li>
                    ))}
                  </ul>
                </article>
              ))}
              <div className="generated-plan-actions">
                <Button variant="primary" size="small" type="button" onClick={openInBuilder}>{t('jaOpenBuilder')}</Button>
                <Button variant="secondary" size="small" type="button" onClick={() => navigate(PAGES.programTemplates.path)}>{t('jaOpenTemplates')}</Button>
                <Button variant="secondary" size="small" type="button" onClick={() => navigate(PAGES.mealPlans.path)}>{t('jaBuildMealPlan')}</Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}