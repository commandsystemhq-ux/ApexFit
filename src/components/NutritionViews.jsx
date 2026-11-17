import { useLocale } from '../contexts/LocaleContext.jsx';
import { summarizeNutrition } from '../services/healthUtils.js';

const STATUS_CLASS = { on: 'is-on', under: 'is-under', over: 'is-over', none: 'is-none' };

// One bar: how much of the goal was eaten. The fill stops at 100% and the number can pass it.
export function ProgressBar({ label, progress, unit }) {
  const { t } = useLocale();
  const percent = progress.percent === null ? 0 : Math.min(progress.percent, 100);
  const shown = progress.value === null ? '-' : Number(progress.value).toLocaleString();
  return (
    <div className={`nutrition-progress ${STATUS_CLASS[progress.status]}`}>
      <div className="nutrition-progress-head">
        <span>{label}</span>
        <strong dir="ltr">{shown}{progress.target !== null ? ` / ${Number(progress.target).toLocaleString()}` : ''} {unit}</strong>
      </div>
      <div className="nutrition-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {progress.status !== 'none' && <small>{progress.percent}% · {t(`nutStatus_${progress.status}`)}</small>}
    </div>
  );
}

// Seven-day averages next to the goal. Used by the client and by the coach.
export function NutritionSummaryView({ logs, targets, today }) {
  const { t } = useLocale();
  const summary = summarizeNutrition(logs, targets, today, 7);
  if (summary.daysLogged === 0) return <p className="muted-copy">{t('nutNoLogs')}</p>;

  return (
    <div className="nutrition-summary">
      <p className="muted-copy">{t('nutAverages')} · {summary.daysLogged}/7 {t('nutDaysLogged')}</p>
      <dl className="health-cards">
        <div><dt>{t('nutCalories')}</dt><dd dir="ltr">{summary.averageCalories === null ? '-' : summary.averageCalories.toLocaleString()}{summary.targetCalories ? ` / ${summary.targetCalories.toLocaleString()}` : ''}</dd></div>
        <div><dt>{t('nutProtein')}</dt><dd dir="ltr">{summary.averageProtein ?? '-'} g</dd></div>
        <div><dt>{t('nutCarbs')}</dt><dd dir="ltr">{summary.averageCarbs ?? '-'} g</dd></div>
        <div><dt>{t('nutFats')}</dt><dd dir="ltr">{summary.averageFats ?? '-'} g</dd></div>
        {summary.adherencePercent !== null && (
          <div><dt>{t('nutAdherence')}</dt><dd dir="ltr">{summary.adherentDays}/{summary.daysWithTarget} ({summary.adherencePercent}%)</dd></div>
        )}
      </dl>
      {summary.targetCalories === null && <p className="muted-copy">{t('nutNoTarget')}</p>}
    </div>
  );
}
