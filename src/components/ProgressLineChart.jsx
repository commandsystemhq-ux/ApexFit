import { useLocale } from '../contexts/LocaleContext.jsx';

const WIDTH = 600;
const HEIGHT = 190;
const PADDING = { top: 18, right: 24, bottom: 30, left: 44 };

export default function ProgressLineChart({ data, field, title, color, unit }) {
  const { t } = useLocale();
  const values = data.flatMap((item) => (
    item[field] === null || item[field] === undefined || item[field] === '' ? [] : [Number(item[field])]
  )).filter(Number.isFinite);
  if (values.length < 2) {
    return <div className="chart-empty">{t('chartNeedEntries')}</div>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.1, 1);
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const points = data.flatMap((item, index) => {
    if (item[field] === null || item[field] === undefined || item[field] === '') return [];
    const value = Number(item[field]);
    if (!Number.isFinite(value)) return [];
    if (!Number.isFinite(value)) return [];
    const x = PADDING.left + (data.length === 1 ? 0 : (index / (data.length - 1)) * plotWidth);
    const y = PADDING.top + ((max - value) / span) * plotHeight;
    return [{ x, y, value, date: item.measured_on }];
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');

  return (
    <div className="progress-chart">
      <h4>{title}</h4>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
        <line x1={PADDING.left} y1={PADDING.top} x2={PADDING.left} y2={HEIGHT - PADDING.bottom} className="chart-axis" />
        <line x1={PADDING.left} y1={HEIGHT - PADDING.bottom} x2={WIDTH - PADDING.right} y2={HEIGHT - PADDING.bottom} className="chart-axis" />
        <text x="4" y={PADDING.top + 4} className="chart-label">{max}{unit}</text>
        <text x="4" y={HEIGHT - PADDING.bottom} className="chart-label">{min}{unit}</text>
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point) => (
          <circle key={`${point.date}-${point.value}`} cx={point.x} cy={point.y} r="4" fill={color}>
            <title>{`${point.date}: ${point.value}${unit}`}</title>
          </circle>
        ))}
        {points.length > 0 && (
          <>
            <text x={PADDING.left} y={HEIGHT - 8} className="chart-label" textAnchor="start">{points[0].date}</text>
            <text x={WIDTH - PADDING.right} y={HEIGHT - 8} className="chart-label" textAnchor="end">{points[points.length - 1].date}</text>
          </>
        )}
      </svg>
    </div>
  );
}
