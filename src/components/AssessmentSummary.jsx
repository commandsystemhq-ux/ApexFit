import { useLocale } from '../contexts/LocaleContext.jsx';
import { flaggedQuestions } from '../services/assessmentUtils.js';

// Coach view of a client's PAR-Q: the medical clearance alert first, then the "yes" answers, goals and injuries.
export default function AssessmentSummary({ assessment }) {
  const { t, locale } = useLocale();
  if (!assessment) return <p className="muted-copy">{t('asmNotSubmitted')}</p>;

  const flagged = flaggedQuestions(assessment.parq_answers);
  return (
    <div className="assessment-summary">
      {assessment.medical_clearance_required && (
        <div className="notice notice-warning" role="alert">
          <strong>{t('asmClearanceBadge')}</strong>
          <p>{t('asmCoachAlert')}</p>
        </div>
      )}
      <dl className="intake-summary-list">
        <div>
          <dt>{t('asmFlaggedHeading')}</dt>
          <dd>
            {flagged.length === 0 ? t('asmAllNo') : (
              <ul className="assessment-flags">
                {flagged.map((key) => <li key={key}>{t(`asmQ${key.slice(1)}`)}</li>)}
              </ul>
            )}
          </dd>
        </div>
        <div><dt>{t('asmGoalsHeading')}</dt><dd>{assessment.fitness_goals}</dd></div>
        <div><dt>{t('asmInjuriesHeading')}</dt><dd>{assessment.injuries_notes || t('asmNoInjuries')}</dd></div>
        <div><dt>{t('asmSubmittedOn')}</dt><dd>{new Date(assessment.submitted_at).toLocaleDateString(locale)}</dd></div>
      </dl>
    </div>
  );
}
