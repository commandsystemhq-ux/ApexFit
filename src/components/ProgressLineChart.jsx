import { useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { summarizeSeries } from '../services/clientTrackingUtils.js';

const WIDTH = 600;
const HEIGHT = 200;
const PADDING = { top: 18, right: 24, bottom: 30, left: 48 };

export default function ProgressLineChart({ data, field, title, color, unit }) {
  const { t } = useLocale();
  const [activeIndex, setActiveIndex] = useState(null);
  const entries = data.filter((item) => (
    item[field] !== null && item[field] !== undefined && item[field] !== '' && Number.isFinite(Number(item[field]))
  ));
  const summary = summarizeSeries(entries, field);

  if (!summary || entries.length < 2) {
    return <div className="chart-empty">{t('chartNeedEntries')}</div>;
  }

  const span = summary.max - summary.min || Math.max(summary.max * 0.1, 1);
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const points = entries.map((item, index) => {
    const value = Number(item[field]);
    return {
      x: PADDING.left + (index / (entries.length - 1)) * plotWidth,
      y: PADDING.top + ((summary.max - value) / span) * plotHeight,
      value,
      date: item.measured_on,
    };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  const active = activeIndex === null ? null : points[activeIndex];
  const tooltipX = active ? Math.min(Math.max(active.x, PADDING.left + 55), WIDTH - PADDING.right - 55) : 0;
  const changeLabel = `${summary.change > 0 ? '+' : ''}${summary.change}${unit}`;

  return (
    <div className="progress-chart">
      <h4>{title}</h4>
      <dl className="chart-stats">
        <div><dt>{t('latestValue')}</dt><dd>{summary.latest}{unit}</dd></div>
        <div><dt>{t('changeValue')}</dt><dd>{changeLabel}</dd></div>
        <div><dt>{t('lowestValue')}</dt><dd>{summary.min}{unit}</dd></div>
        <div><dt>{t('highestValue')}</dt><dd>{summary.max}{unit}</dd></div>
        <div><dt>{t('averageValue')}</dt><dd>{summary.average}{unit}</dd></div>
      </dl>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label={title} onMouseLeave={() => setActiveIndex(null)}>
        <line x1={PADDING.left} y1={PADDING.top} x2={PADDING.left} y2={HEIGHT - PADDING.bottom} className="chart-axis" />
        <line x1={PADDING.left} y1={HEIGHT - PADDING.bottom} x2={WIDTH - PADDING.right} y2={HEIGHT - PADDING.bottom} className="chart-axis" />
        <text x="4" y={PADDING.top + 4} className="chart-label">{summary.max}{unit}</text>
        <text x="4" y={HEIGHT - PADDING.bottom} className="chart-label">{summary.min}{unit}</text>
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => (
          <g key={`${point.date}-${index}`}>
            <circle cx={point.x} cy={point.y} r="14" fill="transparent" onMouseEnter={() => setActiveIndex(index)} />
            <circle
              cx={point.x}
              cy={point.y}
              r={activeIndex === index ? 6 : 4}
              fill={color}
              tabIndex={0}
              role="img"
              aria-label={`${point.date}: ${point.value}${unit}`}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
            />
          </g>
        ))}
        {active && (
          <g className="chart-tooltip" pointerEvents="none">
            <line x1={active.x} y1={PADDING.top} x2={active.x} y2={HEIGHT - PADDING.bottom} className="chart-guide" />
            <rect x={tooltipX - 55} y={Math.max(active.y - 40, 2)} width="110" height="30" rx="6" />
            <text x={tooltipX} y={Math.max(active.y - 40, 2) + 12} textAnchor="middle">{active.date}</text>
            <text x={tooltipX} y={Math.max(active.y - 40, 2) + 25} textAnchor="middle" className="chart-tooltip-value">{active.value}{unit}</text>
          </g>
        )}
        <text x={PADDING.left} y={HEIGHT - 8} className="chart-label" textAnchor="start">{points[0].date}</text>
        <text x={WIDTH - PADDING.right} y={HEIGHT - 8} className="chart-label" textAnchor="end">{points[points.length - 1].date}</text>
      </svg>
    </div>
  );
}
