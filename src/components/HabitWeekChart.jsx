import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import { habitName, habitPercent, isBoolean } from '../services/habitUtils.js';

// Seven days of one habit as bars (a yes/no habit is a full bar on the days it was done), with its streak.
export default function HabitWeekChart({ habit, valuesByDate, days, streak }) {
  const { locale, t } = useLocale();
  return (
    <div className="habit-week-chart">
      <h4 dir="auto">
        <span className={`habit-dot habit-dot-${habit.color}`} aria-hidden="true" /> {habitName(habit, t)}
        {streak > 0 && <span className="habit-streak" title={fillText(t('hbStreak'), { n: streak })}>🔥 {streak}</span>}
      </h4>
      <div className="habit-week-bars">
        {days.map((date) => {
          const value = valuesByDate?.[date];
          const percent = habitPercent(habit, value);
          const label = value === undefined ? '—' : isBoolean(habit) ? '✓' : Number(value).toLocaleString(locale);
          return (
            <div className="habit-week-bar" key={date} title={`${date}: ${label}`}>
              <div className="habit-week-track"><span className={`progress-${habit.color}`} style={{ height: `${percent}%` }} /></div>
              <small>{new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' })}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
