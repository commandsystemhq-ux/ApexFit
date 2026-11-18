import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import HealthMetricsView from './HealthMetricsView.jsx';
import { NutritionSummaryView } from './NutritionViews.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { getHealthOverview, setClientNutritionTargets } from '../services/healthService.js';
import { HEALTH_PROVIDERS, targetsToForm, validateTargetsForm } from '../services/healthUtils.js';

const GOAL_FIELDS = [
  { key: 'calories', labelKey: 'nutCalories' },
  { key: 'protein', labelKey: 'nutProtein' },
  { key: 'carbs', labelKey: 'nutCarbs' },
  { key: 'fats', labelKey: 'nutFats' },
];

// What the coach (or an assistant trainer allowed to see assessments) sees for one client:
// the last seven days from their devices, and how well they follow their calorie and macro goal.
export default function ClientHealthPanel({ clientId, canSetTargets = false }) {
  const { t } = useLocale();
  const today = getLocalDateString();
  const [state, setState] = useState({ status: 'loading', overview: null, error: '' });
  const [form, setForm] = useState(targetsToForm(null));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  async function load() {
    try {
      const overview = await getHealthOverview(clientId, 8);
      setState({ status: 'ready', overview, error: '' });
      setForm(targetsToForm(overview.nutrition.targets));
    } catch (error) {
      setState({ status: 'error', overview: null, error: error.message });
    }
  }

  useEffect(() => {
    setState({ status: 'loading', overview: null, error: '' });
    setNotice(null);
    load();
  }, [clientId]);

  async function saveTargets(event) {
    event.preventDefault();
    const result = validateTargetsForm(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setSaving(true);
    setNotice(null);
    try {
      await setClientNutritionTargets(clientId, result.payload);
      await load();
      setNotice({ kind: 'info', text: t('nutTargetsSaved') });
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('nutSaveError')} ${error.message}` });
    } finally {
      setSaving(false);
    }
  }

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{t('hltLoadError')} {state.error}</div>;

  const { overview } = state;
  const connected = overview.connections.filter((item) => item.status === 'connected').map((item) => item.provider);
  const sources = HEALTH_PROVIDERS.filter((provider) => connected.includes(provider) || overview.metrics.some((row) => row.provider === provider));

  return (
    <div className="compliance-panel health-panel">
      <h4>{t('hltCoachTitle')}</h4>
      {sources.length > 0 && (
        <p className="contract-badges">
          {sources.map((provider) => <span className="soft-badge badge-cyan" key={provider}>{t(`hltProv_${provider}`)}</span>)}
        </p>
      )}
      <HealthMetricsView metrics={overview.metrics} today={today} />

      <h4>{t('nutCoachTitle')}</h4>
      <NutritionSummaryView logs={overview.nutrition.logs} targets={overview.nutrition.targets} today={today} />

      {canSetTargets && (
        <form className="health-targets-form" onSubmit={saveTargets} noValidate>
          <h5>{t('nutClientTargets')}</h5>
          <div className="food-macro-grid">
            {GOAL_FIELDS.map((field) => (
              <label className="form-label" key={field.key}>{t(field.labelKey)}
                <input className="field" type="number" inputMode="decimal" min="0" step="1" value={form[field.key]} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))} aria-invalid={Boolean(errors[field.key])} />
                {errors[field.key] && <small className="field-error">{t(errors[field.key])}</small>}
              </label>
            ))}
          </div>
          {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
          <Button variant="secondary" type="submit" disabled={saving}>{saving ? t('nutSaving') : t('nutTargetsSave')}</Button>
        </form>
      )}
    </div>
  );
}
