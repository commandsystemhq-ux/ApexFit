import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../components/Button.jsx';
import { refreshOnboardingNotices } from '../components/OnboardingNotice.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { listMyCoaches } from '../services/coachClientService.js';
import { listMyAssessments, submitAssessment } from '../services/assessmentService.js';
import {
  ASSESSMENT_LIMITS,
  PARQ_KEYS,
  answersFromRecord,
  emptyAnswers,
  needsMedicalClearance,
  validateAssessmentForm,
} from '../services/assessmentUtils.js';
import { PAGES } from '../routes.js';

export default function AssessmentPage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const [coaches, setCoaches] = useState([]);
  const [assessments, setAssessments] = useState([]);
  const [coachId, setCoachId] = useState('');
  const [answers, setAnswers] = useState(emptyAnswers());
  const [goals, setGoals] = useState('');
  const [injuries, setInjuries] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([listMyCoaches(), listMyAssessments()])
      .then(([coachRows, assessmentRows]) => {
        if (!active) return;
        const activeCoaches = coachRows.filter((coach) => coach.status === 'active');
        setCoaches(activeCoaches);
        setAssessments(assessmentRows);
        setCoachId(activeCoaches[0]?.coach_id || '');
      })
      .catch((error) => {
        if (active) setLoadError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const existing = useMemo(() => assessments.find((item) => item.coach_id === coachId) || null, [assessments, coachId]);

  // Show the saved answers again whenever the selected coach (or the saved record) changes.
  useEffect(() => {
    setAnswers(existing ? answersFromRecord(existing.parq_answers) : emptyAnswers());
    setGoals(existing?.fitness_goals || '');
    setInjuries(existing?.injuries_notes || '');
    setAttempted(false);
  }, [existing]);

  const clearance = existing ? existing.medical_clearance_required : false;
  const formClearance = needsMedicalClearance(answers);
  // After the first submit attempt the messages follow the form, so they disappear as soon as a field is fixed.
  const errors = attempted ? validateAssessmentForm({ answers, goals, injuries }).errors : {};

  async function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    const result = validateAssessmentForm({ answers, goals, injuries });
    if (!result.valid) return;

    setSaving(true);
    try {
      const saved = await submitAssessment({ coachId, answers: result.payload.answers, goals: result.payload.goals, injuries: result.payload.injuries });
      setAssessments(await listMyAssessments());
      refreshOnboardingNotices();
      showToast(t('asmSaved'));
      if (saved.medical_clearance_required) window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      showToast(`${t('asmSaveError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('asmTitle')} description={t('asmDescription')} />
      {loadError && <div className="notice notice-error" role="alert">{t('asmLoadError')} {loadError}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}

      {!loading && !loadError && coaches.length === 0 && (
        <section className="panel">
          <div className="dashboard-empty">
            <h3>{t('asmNoCoachTitle')}</h3>
            <p>{t('asmNoCoachHelp')}</p>
            <Link className="button button-primary" to={PAGES.coachHub.path}>{t('asmNoCoachCta')}</Link>
          </div>
        </section>
      )}

      {!loading && !loadError && coaches.length > 0 && (
        <form className="panel assessment-form" onSubmit={handleSubmit} noValidate>
          {existing && (
            <div className={`notice ${clearance ? 'notice-warning' : 'notice-info'}`} role={clearance ? 'alert' : 'status'}>
              <strong>{clearance ? t('asmClearanceTitle') : t('asmSummaryTitle')}</strong>
              <p>{clearance ? t('asmClearanceBody') : t('asmClearanceOk')}</p>
              <small>{t('asmSubmittedOn')} {new Date(existing.submitted_at).toLocaleDateString(locale)}</small>
            </div>
          )}

          {coaches.length > 1 && (
            <label className="form-label">
              <span>{t('asmCoachLabel')}</span>
              <select className="field" value={coachId} onChange={(event) => setCoachId(event.target.value)}>
                {coaches.map((coach) => <option key={coach.coach_id} value={coach.coach_id}>{coach.coach_name || coach.coach_email}</option>)}
              </select>
            </label>
          )}

          <div className="panel-heading"><div><span className="eyebrow">PAR-Q</span><h3>{t('asmParqHeading')}</h3></div></div>
          <p className="muted-copy">{t('asmParqIntro')}</p>
          {fieldError(errors.answers)}

          <div className="parq-list">
            {PARQ_KEYS.map((key, index) => (
              <fieldset className={`parq-question ${answers[key] === true ? 'is-yes' : ''}`} key={key}>
                <legend>{index + 1}. {t(`asmQ${index + 1}`)}</legend>
                <div className="parq-choices">
                  <label className="parq-choice">
                    <input type="radio" name={key} checked={answers[key] === true} onChange={() => setAnswers((current) => ({ ...current, [key]: true }))} />
                    <span>{t('asmYes')}</span>
                  </label>
                  <label className="parq-choice">
                    <input type="radio" name={key} checked={answers[key] === false} onChange={() => setAnswers((current) => ({ ...current, [key]: false }))} />
                    <span>{t('asmNo')}</span>
                  </label>
                </div>
              </fieldset>
            ))}
          </div>

          {formClearance && !clearance && (
            <div className="notice notice-warning" role="alert">
              <strong>{t('asmClearanceTitle')}</strong>
              <p>{t('asmClearanceBody')}</p>
            </div>
          )}

          <label className="form-label">
            <span>{t('asmGoalsLabel')}</span>
            <textarea className="field" rows={3} maxLength={ASSESSMENT_LIMITS.goals + 100} value={goals} placeholder={t('asmGoalsPlaceholder')} onChange={(event) => setGoals(event.target.value)} aria-invalid={Boolean(errors.goals)} />
            {fieldError(errors.goals)}
          </label>
          <label className="form-label">
            <span>{t('asmInjuriesLabel')}</span>
            <textarea className="field" rows={3} maxLength={ASSESSMENT_LIMITS.injuries + 100} value={injuries} placeholder={t('asmInjuriesPlaceholder')} onChange={(event) => setInjuries(event.target.value)} aria-invalid={Boolean(errors.injuries)} />
            {fieldError(errors.injuries)}
          </label>

          <small className="muted-copy">{t('asmDisclaimer')}</small>
          <div className="assessment-actions">
            <Button type="submit" variant="primary" disabled={saving}>{saving ? t('asmSubmitting') : existing ? t('asmUpdate') : t('asmSubmit')}</Button>
          </div>
        </form>
      )}
    </>
  );
}
