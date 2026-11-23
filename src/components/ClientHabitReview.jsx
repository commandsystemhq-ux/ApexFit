import { useEffect, useState } from 'react';
import HabitWeekChart from './HabitWeekChart.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { listHabitValues, listHabits } from '../services/habitService.js';
import { STREAK_LOOKBACK_DAYS, activeHabits, buildHabitValues, calculateStreak, habitMet, habitName, habitUnit, isBoolean, weekDays } from '../services/habitUtils.js';

// A coach's read-only view of one client's habits: today's state, the streak and the last seven days of each.
export default function ClientHabitReview({ clientId }) {
  const { locale, t } = useLocale();
  const today = getLocalDateString();
  const [state, setState] = useState({ status: 'loading', habits: [], values: {}, error: '' });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading', habits: [], values: {}, error: '' });
    Promise.all([listHabits(clientId), listHabitValues(shiftDate(today, -(STREAK_LOOKBACK_DAYS - 1)), today, clientId)])
      .then(([list, logs]) => current && setState({ status: 'ready', habits: activeHabits(list), values: buildHabitValues(list, logs.dailyLogs, logs.customLogs), error: '' }))
      .catch((error) => current && setState({ status: 'error', habits: [], values: {}, error: error.message }));
    return () => { current = false; };
  }, [clientId, today]);

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{t('habitLoadError')} {state.error}</div>;
  if (state.habits.length === 0) return <div className="empty-state">{t('hbReviewEmpty')}</div>;

  const days = weekDays(today);
  const reached = state.habits.filter((habit) => habitMet(habit, state.values[habit.id]?.[today])).length;

  return (
    <div className="habit-review">
      <p className="muted-copy">{t('hbReviewIntro')}</p>
      <p className="food-review-summary">{t('habitToday')}: <strong>{reached} / {state.habits.length}</strong> {t('goalsReached')}</p>
      {state.habits.map((habit) => (
        <div key={habit.id}>
          <HabitWeekChart habit={habit} valuesByDate={state.values[habit.id]} days={days} streak={calculateStreak(habit, state.values[habit.id], today)} />
          <small className="muted-copy">
            {t('dailyGoal')}: {isBoolean(habit) ? t('hbOncePerDay') : `${Number(habit.daily_goal).toLocaleString(locale)} ${habitUnit(habit, t)}`.trim()}
            {' Â· '}{habitName(habit, t)}: {habitMet(habit, state.values[habit.id]?.[today]) ? t('hbDoneToday') : t('hbNotDone')}
          </small>
        </div>
      ))}
    </div>
  );
}
