import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import ProgressBar from './ProgressBar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { HABIT_GOALS, calculateGoalPercent, getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { listClientHabitLogs, saveClientHabitLog } from '../services/clientProgressService.js';

const HABITS = [
  { key: 'sleepHours', field: 'sleep_hours', label: 'sleepHours', unit: 'hours', max: 24, step: '0.25', quickAdd: 0.5, color: 'blue' },
  { key: 'waterLiters', field: 'water_liters', label: 'waterLiters', unit: 'liters', max: 50, step: '0.1', quickAdd: 0.25, color: 'green' },
  { key: 'steps', field: 'steps', label: 'steps', unit: null, max: 200000, step: '1', quickAdd: 1000, color: 'amber' },
];

function roundValue(value) {
  return Math.round(value * 100) / 100;
}

export default function ClientHabitTracker() {
  const { locale, t } = useLocale();
  const today = getLocalDateString();
  const [form, setForm] = useState({ sleepHours: '', waterLiters: '', steps: '' });
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  async function refreshHistory() {
    setLoading(true);
    setLoadError('');
    try {
      const logs = await listClientHabitLogs(shiftDate(today, -6), today);
      setHistory(logs);
      const todayLog = logs.find((log) => log.habit_date === today);
      if (todayLog) {
        setForm({
          sleepHours: todayLog.sleep_hours === null ? '' : String(todayLog.sleep_hours),
          waterLiters: todayLog.water_liters === null ? '' : String(todayLog.water_liters),
          steps: todayLog.steps === null ? '' : String(todayLog.steps),
        });
      }
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshHistory();
  }, [today]);

  function updateHabit(key, value) {
    setSuccess('');
    setForm((current) => ({ ...current, [key]: value }));
  }

  function quickAdd(habit) {
    const current = Number(form[habit.key]) || 0;
    updateHabit(habit.key, String(Math.min(habit.max, roundValue(current + habit.quickAdd))));
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaveError('');
    setSuccess('');
    setSaving(true);
    try {
      await saveClientHabitLog({
        habitDate: today,
        sleepHours: form.sleepHours,
        waterLiters: form.waterLiters,
        steps: form.steps,
      });
      setSuccess(t('habitsSaved'));
      await refreshHistory();
    } catch (error) {
      setSaveError(`${t('habitSaveError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  const logsByDate = new Map(history.map((log) => [log.habit_date, log]));
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(today, index - 6);
    return {
      date,
      log: logsByDate.get(date) || null,
      weekday: new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' }),
    };
  });
  const goalsReached = HABITS.filter((habit) => calculateGoalPercent(form[habit.key], HABIT_GOALS[habit.key]) >= 100).length;

  return (
    <div className="client-habits-layout">
      <form className="panel client-habit-form" onSubmit={handleSave}>
        <div className="panel-heading"><div><span className="eyebrow">{t('habitTracker')}</span><h3>{t('habitToday')} · {today}</h3></div>
          <span className="soft-badge badge-muted">{goalsReached} / {HABITS.length} {t('goalsReached')}</span>
        </div>
        <div className="habit-goal-list">
          {HABITS.map((habit) => {
            const percent = calculateGoalPercent(form[habit.key], HABIT_GOALS[habit.key]);
            return (
              <div className="habit-goal-card" key={habit.key}>
                <label className="form-label">{t(habit.label)}
                  <input className="field" type="number" min="0" max={habit.max} step={habit.step} value={form[habit.key]} onChange={(event) => updateHabit(habit.key, event.target.value)} />
                </label>
                <ProgressBar value={percent} color={habit.color} />
                <div className="habit-goal-meta">
                  <span>{t('dailyGoal')}: {HABIT_GOALS[habit.key].toLocaleString()} {habit.unit ? t(habit.unit) : ''}</span>
                  <strong>{percent}%</strong>
                </div>
                <Button variant="secondary" size="small" type="button" onClick={() => quickAdd(habit)}>+ {habit.quickAdd.toLocaleString()} {habit.unit ? t(habit.unit) : t('steps')}</Button>
              </div>
            );
          })}
        </div>
        {saveError && <div className="notice notice-error" role="alert">{saveError}</div>}
        {success && <div className="notice notice-info" role="status">{success}</div>}
        <Button variant="primary" type="submit" disabled={saving}>{saving ? t('savingHabits') : t('saveHabits')}</Button>
      </form>

      <section className="panel client-habit-history">
        <div className="panel-heading"><div><span className="eyebrow">{t('habitTracker')}</span><h3>{t('habitHistory')}</h3></div></div>
        {loadError && <div className="notice notice-error" role="alert">{t('habitLoadError')} {loadError}</div>}
        {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!loading && !loadError && history.length === 0 && <div className="empty-state">{t('noHabitHistory')}</div>}
        {!loading && history.length > 0 && (
          <>
            {HABITS.map((habit) => (
              <div className="habit-week-chart" key={habit.key}>
                <h4>{t(habit.label)}</h4>
                <div className="habit-week-bars">
                  {week.map(({ date, log, weekday }) => {
                    const value = log?.[habit.field];
                    const percent = calculateGoalPercent(value, HABIT_GOALS[habit.key]);
                    return (
                      <div className="habit-week-bar" key={date} title={`${date}: ${value ?? '—'}`}>
                        <div className="habit-week-track"><span className={`progress-${habit.color}`} style={{ height: `${percent}%` }} /></div>
                        <small>{weekday}</small>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="habit-history-list">
              {history.map((log) => (
                <article className="habit-history-row" key={log.id}>
                  <strong>{log.habit_date}</strong>
                  <span>{t('sleepHours')}: {log.sleep_hours ?? '—'} {t('hours')}</span>
                  <span>{t('waterLiters')}: {log.water_liters ?? '—'} {t('liters')}</span>
                  <span>{t('steps')}: {log.steps === null ? '—' : Number(log.steps).toLocaleString()}</span>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
