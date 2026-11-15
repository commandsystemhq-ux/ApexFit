import { useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { generateTrainingPlan } from '../services/aiService.js';

export default function GeneratorPage({ onNotify }) {
  const { t } = useLocale();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [environment, setEnvironment] = useState('gym');
  const [form, setForm] = useState({ client: '', goal: '', days: '3', limitations: '', nutrition: false });

  function updateField(event) {
    const { name, value, checked, type } = event.target;
    setForm((current) => ({ ...current, [name]: type === 'checkbox' ? checked : value }));
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await generateTrainingPlan({ ...form, environment });
      onNotify(t('planGenerated'));
    } catch (generationError) {
      setError(generationError.code === 'AI_NOT_CONFIGURED' ? t('generatorUnavailable') : generationError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('generatorTitle')} description={t('generatorDescription')} />
      <div className="generator-layout">
        <form className="panel generator-form" onSubmit={handleGenerate}>
          <div className="generator-title"><span className="feature-icon">✦</span><div><h3>{t('planDetails')}</h3></div></div>
          <label className="form-label">{t('clientName')}<input className="field" name="client" value={form.client} onChange={updateField} required /></label>
          <label className="form-label">{t('goal')}<input className="field" name="goal" value={form.goal} onChange={updateField} required /></label>
          <label className="form-label">{t('trainingDays')}<select className="field" name="days" value={form.days} onChange={updateField}>{['1', '2', '3', '4', '5', '6', '7'].map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
          <fieldset className="environment-picker">
            <legend className="form-label">{t('environment')}</legend>
            {[['gym', 'fullGym'], ['home', 'home'], ['bodyweight', 'bodyweight']].map(([value, label]) => (
              <button key={value} className={`choice-chip ${environment === value ? 'is-selected' : ''}`} type="button" onClick={() => setEnvironment(value)}>{t(label)}</button>
            ))}
          </fieldset>
          <label className="form-label">{t('limitations')}<input className="field" name="limitations" value={form.limitations} onChange={updateField} /></label>
          <label className="checkbox-label"><input type="checkbox" name="nutrition" checked={form.nutrition} onChange={updateField} /> {t('nutrition')}</label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <Button variant="primary" type="submit" disabled={loading}>{loading ? t('preparing') : t('generate')}</Button>
        </form>
        <section className="panel plan-output">
          <div className="panel-heading"><div><span className="eyebrow">{t('generatorTitle')}</span><h3>{t('planOutputTitle')}</h3></div></div>
          <div className="dashboard-empty">
            <span className="feature-icon" aria-hidden="true">✦</span>
            <p>{t('planOutputDescription')}</p>
          </div>
        </section>
      </div>
    </>
  );
}
