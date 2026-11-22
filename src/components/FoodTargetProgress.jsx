import { useLocale } from '../contexts/LocaleContext.jsx';

// What is eaten against the daily goal, one bar per number the goal has, with what is left (or how much over).
export default function FoodTargetProgress({ rows }) {
  const { t, locale } = useLocale();
  const number = (value) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  return (
    <ul className="food-target-rows">
      {rows.map((row) => (
        <li key={row.key} className={row.over ? 'is-over' : ''}>
          <div className="food-target-top">
            <strong>{t(row.labelKey)}</strong>
            <span dir="auto">{number(row.eaten)} / {number(row.goal)} {row.unit === 'kcal' ? t('kcal') : t('foodGramsUnit')}</span>
          </div>
          <div className="food-target-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.percent} aria-label={t(row.labelKey)}>
            <span style={{ width: `${row.percent}%` }} />
          </div>
          <small>{row.over ? `${t('foodTargetOver')}: ${number(Math.abs(row.remaining))}` : `${t('foodTargetLeft')}: ${number(row.remaining)}`}</small>
        </li>
      ))}
    </ul>
  );
}
