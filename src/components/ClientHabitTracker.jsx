import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { listClientHabitLogs, saveClientHabitLog } from '../services/clientProgressService.js';

export default function ClientHabitTracker() {
  const { t } = useLocale();
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

  return (
    <div className="client-habits-layout">
      <form className="panel client-habit-form" onSubmit={handleSave}>
        <div className="panel-heading"><div><span className="eyebrow">{t('habitTracker')}</span><h3>{t('habitToday')} · {today}</h3></div></div>
        <div className="habit-input-grid">
          <label className="form-label">{t('sleepHours')}<input className="field" type="number" min="0" max="24" step="0.25" value={form.sleepHours} onChange={(event) => setForm((current) => ({ ...current, sleepHours: event.target.value }))} /></label>
          <label className="form-label">{t('waterLiters')}<input className="field" type="number" min="0" max="50" step="0.1" value={form.waterLiters} onChange={(event) => setForm((current) => ({ ...current, waterLiters: event.target.value }))} /></label>
          <label className="form-label">{t('steps')}<input className="field" type="number" min="0" max="200000" step="1" value={form.steps} onChange={(event) => setForm((current) => ({ ...current, steps: event.target.value }))} /></label>
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
        )}
      </section>
    </div>
  );
}
