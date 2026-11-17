import { useLocale } from '../contexts/LocaleContext.jsx';
import { buildSeries, formatSleep, summarizeSeries } from '../services/healthUtils.js';

const CHARTS = [
  { field: 'steps', labelKey: 'hltSteps', format: (value) => Number(value).toLocaleString() },
  { field: 'sleep_minutes', labelKey: 'hltSleep', format: formatSleep },
  { field: 'resting_heart_rate', labelKey: 'hltRestingHr', format: (value) => `${value}` },
  { field: 'recovery_score', labelKey: 'hltRecovery', format: (value) => `${value}` },
];

function MiniBars({ series, field, format, label, locale }) {
  const values = series.map((day) => day[field]);
  const max = Math.max(...values.map((value) => value ?? 0), 1);
  return (
    <div className="health-chart" role="img" aria-label={label}>
      <div className="health-chart-bars">
        {series.map((day) => {
          const value = day[field];
          const weekday = new Date(`${day.date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' });
          return (
            <div className="health-chart-column" key={day.date} title={`${day.date}: ${value === null ? '-' : format(value)}`}>
              <span className="health-chart-bar" style={{ height: `${value === null ? 0 : Math.max(6, Math.round((value / max) * 100))}%` }} data-empty={value === null} />
              <small>{weekday}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Seven-day cards and mini charts for the merged device data. Used for the client and in the coach's client row.
export default function HealthMetricsView({ metrics, today }) {
  const { t, locale } = useLocale();
  const series = buildSeries(metrics, today, 7);
  const summary = summarizeSeries(series);

  if (summary.daysWithData === 0) return <p className="muted-copy">{t('hltNoData')}</p>;

  const cards = [
    { key: 'hltSteps', value: summary.steps === null ? '-' : summary.steps.toLocaleString() },
    { key: 'hltSleep', value: summary.sleepMinutes === null ? '-' : formatSleep(summary.sleepMinutes) },
    { key: 'hltRestingHr', value: summary.restingHeartRate === null ? '-' : `${summary.restingHeartRate} ${t('hltBpm')}` },
    { key: 'hltRecovery', value: summary.recoveryScore === null ? '-' : `${summary.recoveryScore}/100` },
    { key: 'hltActiveCalories', value: summary.activeCalories === null ? '-' : `${summary.activeCalories.toLocaleString()} ${t('nutKcal')}` },
    { key: 'hltHrv', value: summary.hrvMs === null ? '-' : `${summary.hrvMs} ms` },
  ];

  return (
    <div className="health-metrics">
      <p className="muted-copy">{t('hltAverages')} · {summary.daysWithData}/7 {t('hltDaysWithData')}</p>
      <dl className="health-cards">
        {cards.map((card) => (
          <div key={card.key}><dt>{t(card.key)}</dt><dd dir="ltr">{card.value}</dd></div>
        ))}
      </dl>
      <div className="health-charts">
        {CHARTS.map((chart) => (
          <div key={chart.field}>
            <h5>{t(chart.labelKey)}</h5>
            <MiniBars series={series} field={chart.field} format={chart.format} label={t(chart.labelKey)} locale={locale} />
          </div>
        ))}
      </div>
    </div>
  );
}
