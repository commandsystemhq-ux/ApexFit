import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMyIntakeForm, saveMyIntakeForm } from '../services/clientIntakeService.js';
import { EQUIPMENT_ACCESS, EXPERIENCE_LEVELS, INTAKE_GOALS } from '../services/clientPriority2Utils.js';

const GOAL_LABELS = {
  fat_loss: 'goalFatLoss',
  muscle_gain: 'goalMuscleGain',
  strength: 'goalStrength',
  endurance: 'goalEndurance',
  general_fitness: 'goalGeneralFitness',
};
const EQUIPMENT_LABELS = { full_gym: 'fullGym', home_gym: 'equipHomeGym', bodyweight_only: 'equipBodyweight' };

const EMPTY_FORM = {
  primary_goal: 'general_fitness',
  experience_level: 'beginner',
  training_days_per_week: '3',
  equipment_access: 'full_gym',
  height_cm: '',
  injuries: '',
  medical_conditions: '',
  dietary_preferences: '',
  additional_notes: '',
};

function toFormValues(row) {
  return {
    ...EMPTY_FORM,
    ...row,
    training_days_per_week: String(row.training_days_per_week),
    height_cm: row.height_cm === null ? '' : String(row.height_cm),
  };
}

export default function ClientIntakeForm({ onCompleted }) {
  const { locale, t } = useLocale();
  const [form, setForm] = useState(EMPTY_FORM);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getMyIntakeForm()
      .then((row) => {
        if (!active || !row) return;
        setForm(toFormValues(row));
        setUpdatedAt(row.updated_at);
      })
      .catch((error) => {
        if (active) setLoadError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  function update(field, value) {
    setSuccess('');
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSaveError('');
    setSuccess('');
    setSaving(true);
    try {
      await saveMyIntakeForm(form);
      const saved = await getMyIntakeForm();
      setUpdatedAt(saved?.updated_at || null);
      setSuccess(t('intakeSaved'));
      onCompleted?.();
    } catch (error) {
      setSaveError(`${t('intakeSaveError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel intake-form" onSubmit={handleSubmit}>
      <div className="panel-heading">
        <div><span className="eyebrow">{t('intakeTab')}</span><h3>{t('intakeTitle')}</h3></div>
        {updatedAt && <span className="soft-badge badge-muted">{t('intakeUpdatedAt')} {new Date(updatedAt).toLocaleDateString(locale)}</span>}
      </div>
      <p className="muted-copy">{t('intakeDescription')}</p>
      {loadError && <div className="notice notice-error" role="alert">{t('intakeLoadError')} {loadError}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      <fieldset className="intake-fields" disabled={loading || saving}>
        <div className="form-grid">
          <label className="form-label">{t('intakeGoal')}
            <select className="field" value={form.primary_goal} onChange={(event) => update('primary_goal', event.target.value)}>
              {INTAKE_GOALS.map((goal) => <option key={goal} value={goal}>{t(GOAL_LABELS[goal])}</option>)}
            </select>
          </label>
          <label className="form-label">{t('intakeExperience')}
            <select className="field" value={form.experience_level} onChange={(event) => update('experience_level', event.target.value)}>
              {EXPERIENCE_LEVELS.map((level) => <option key={level} value={level}>{t(`difficulty_${level}`)}</option>)}
            </select>
          </label>
          <label className="form-label">{t('intakeTrainingDays')}
            <input className="field" type="number" min="1" max="7" step="1" value={form.training_days_per_week} onChange={(event) => update('training_days_per_week', event.target.value)} required />
          </label>
          <label className="form-label">{t('intakeEquipment')}
            <select className="field" value={form.equipment_access} onChange={(event) => update('equipment_access', event.target.value)}>
              {EQUIPMENT_ACCESS.map((option) => <option key={option} value={option}>{t(EQUIPMENT_LABELS[option])}</option>)}
            </select>
          </label>
          <label className="form-label">{t('intakeHeight')}
            <input className="field" type="number" min="50" max="275" step="0.1" value={form.height_cm} onChange={(event) => update('height_cm', event.target.value)} />
          </label>
        </div>
        <label className="form-label">{t('intakeInjuries')}
          <textarea className="field intake-textarea" maxLength={1000} value={form.injuries} onChange={(event) => update('injuries', event.target.value)} />
        </label>
        <label className="form-label">{t('intakeMedical')}
          <textarea className="field intake-textarea" maxLength={1000} value={form.medical_conditions} onChange={(event) => update('medical_conditions', event.target.value)} />
        </label>
        <label className="form-label">{t('intakeDiet')}
          <textarea className="field intake-textarea" maxLength={500} value={form.dietary_preferences} onChange={(event) => update('dietary_preferences', event.target.value)} />
        </label>
        <label className="form-label">{t('intakeNotes')}
          <textarea className="field intake-textarea" maxLength={1000} value={form.additional_notes} onChange={(event) => update('additional_notes', event.target.value)} />
        </label>
      </fieldset>
      <p className="muted-copy">{t('intakePrivacy')}</p>
      {saveError && <div className="notice notice-error" role="alert">{saveError}</div>}
      {success && <div className="notice notice-info" role="status">{success}</div>}
      <Button variant="primary" type="submit" disabled={loading || saving}>{saving ? t('intakeSaving') : t('intakeSave')}</Button>
    </form>
  );
}
