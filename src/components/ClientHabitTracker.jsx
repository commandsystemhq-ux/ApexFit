import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import HabitWeekChart from './HabitWeekChart.jsx';
import { HabitEditorModal, HabitRemoveModal } from './HabitModals.jsx';
import ProgressBar from './ProgressBar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';
import { deleteHabit, ensureDefaultHabits, listHabitValues, listHabits, logHabit, saveHabit, setHabitStatus } from '../services/habitService.js';
import {
  MAX_HABITS, STREAK_LOOKBACK_DAYS, activeHabits, addQuickAmount, archivedHabits, buildHabitValues, calculateStreak, formFromHabit,
  habitMax, habitMet, habitName, habitPercent, habitUnit, isBoolean, summarizeGoals, weekDays,
} from '../services/habitUtils.js';

const savedText = (value) => (value === undefined || value === null ? '' : String(value));

export default function ClientHabitTracker() {
  const { locale, t } = useLocale();
  const today = getLocalDateString();
  const [habits, setHabits] = useState([]);
  const [values, setValues] = useState({});
  const [drafts, setDrafts] = useState({});
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [modal, setModal] = useState(null);

  const refresh = useCallback(async ({ resetDrafts = true } = {}) => {
    try {
      await ensureDefaultHabits();
      const [list, logs] = await Promise.all([listHabits(), listHabitValues(shiftDate(today, -(STREAK_LOOKBACK_DAYS - 1)), today)]);
      const nextValues = buildHabitValues(list, logs.dailyLogs, logs.customLogs);
      setHabits(list);
      setValues(nextValues);
      if (resetDrafts) {
        setDrafts(Object.fromEntries(activeHabits(list).filter((habit) => !isBoolean(habit)).map((habit) => [habit.id, savedText(nextValues[habit.id]?.[today])])));
      }
      setLoadError('');
      setStatus('ready');
    } catch (error) {
      setLoadError(error.message);
      setStatus('error');
    }
  }, [today]);

  useEffect(() => {
    setStatus('loading');
    refresh();
  }, [refresh]);

  const active = useMemo(() => activeHabits(habits), [habits]);
  const archived = useMemo(() => archivedHabits(habits), [habits]);
  const goals = summarizeGoals(habits, values, drafts, today);
  const days = weekDays(today);
  const dirty = active.filter((habit) => !isBoolean(habit) && savedText(drafts[habit.id]) !== savedText(values[habit.id]?.[today]));

  const say = (kind, text) => setNotice({ kind, text });

  function typeValue(habit, text) {
    setNotice(null);
    setDrafts((current) => ({ ...current, [habit.id]: text }));
  }

  async function saveToday(event) {
    event.preventDefault();
    setNotice(null);
    setSaving(true);
    try {
      for (const habit of dirty) {
        const text = String(drafts[habit.id] ?? '').trim();
        const value = text === '' ? null : Number(text);
        const invalid = value !== null && (!Number.isFinite(value) || value < 0 || value > habitMax(habit) || (habit.builtin_key === 'steps' && !Number.isInteger(value)));
        if (invalid) throw new RangeError(habitName(habit, t));
        await logHabit(habit.id, today, value);
      }
      await refresh();
      say('info', t('habitsSaved'));
    } catch (error) {
      say('error', `${t('habitSaveError')} ${error.message}`);
      await refresh({ resetDrafts: false });
    } finally {
      setSaving(false);
    }
  }

  async function toggleDone(habit) {
    setNotice(null);
    setBusyId(habit.id);
    try {
      await logHabit(habit.id, today, habitMet(habit, values[habit.id]?.[today]) ? 0 : 1);
      await refresh({ resetDrafts: false });
    } catch (error) {
      say('error', `${t('habitSaveError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function submitHabit(payload) {
    await saveHabit(payload);
    setModal(null);
    await refresh();
    say('info', t('hbSaved'));
  }

  async function archiveHabit(habit) {
    await setHabitStatus(habit.id, 'archived');
    setModal(null);
    await refresh();
    say('info', t('hbArchived'));
  }

  async function restoreHabit(habit) {
    setNotice(null);
    try {
      await setHabitStatus(habit.id, 'active');
      await refresh();
      say('info', t('hbRestored'));
    } catch (error) {
      say('error', `${t('hbActionError')} ${error.message}`);
    }
  }

  async function removeHabit(habit) {
    await deleteHabit(habit.id);
    setModal(null);
    await refresh();
    say('info', t('hbDeleted'));
  }

  const goalText = (habit) => (isBoolean(habit)
    ? t('hbOncePerDay')
    : `${Number(habit.daily_goal).toLocaleString(locale)} ${habitUnit(habit, t)}`.trim());
  const limitReached = habits.length >= MAX_HABITS;

  return (
    <div className="client-habits-layout">
      <form className="panel client-habit-form" onSubmit={saveToday}>
        <div className="panel-heading">
          <div><span className="eyebrow">{t('habitTracker')}</span><h3>{t('habitToday')} · {today}</h3></div>
          <span className="soft-badge badge-muted">{goals.reached} / {goals.total} {t('goalsReached')}</span>
        </div>
        <div className="habit-toolbar">
          <Button variant="primary" size="small" type="button" disabled={limitReached || status !== 'ready'} onClick={() => setModal({ type: 'edit', initial: null })}>{t('hbAddHabit')}</Button>
          {limitReached && <small className="muted-copy">{fillText(t('hbMaxReached'), { n: MAX_HABITS })}</small>}
        </div>

        {status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {status === 'error' && <div className="notice notice-error" role="alert">{t('habitLoadError')} {loadError}</div>}
        {status === 'ready' && active.length === 0 && <div className="empty-state">{t('hbNoHabits')}</div>}

        <div className="habit-goal-list">
          {active.map((habit) => {
            const name = habitName(habit, t);
            const saved = values[habit.id]?.[today];
            const boolean = isBoolean(habit);
            const percent = habitPercent(habit, boolean ? saved : drafts[habit.id]);
            const streak = calculateStreak(habit, values[habit.id], today);
            const unit = habitUnit(habit, t);
            const done = habitMet(habit, saved);
            return (
              <div className="habit-goal-card" key={habit.id}>
                <div className="habit-card-head">
                  <span className={`habit-dot habit-dot-${habit.color}`} aria-hidden="true" />
                  <strong dir="auto">{name}</strong>
                  {streak > 0 && <span className="habit-streak" title={fillText(t('hbStreak'), { n: streak })}>🔥 {fillText(t('hbStreak'), { n: streak })}</span>}
                  <span className="habit-card-actions">
                    <button type="button" className="icon-button" onClick={() => setModal({ type: 'edit', initial: formFromHabit(habit) })} aria-label={`${t('hbEdit')}: ${name}`} title={t('hbEdit')}>✏️</button>
                    <button type="button" className="icon-button" onClick={() => setModal({ type: 'remove', habit })} aria-label={`${t('hbRemove')}: ${name}`} title={t('hbRemove')}>🗑️</button>
                  </span>
                </div>
                {boolean ? (
                  <button type="button" className={`habit-check ${done ? 'is-done' : ''}`} aria-pressed={done} disabled={busyId === habit.id} onClick={() => toggleDone(habit)}>
                    <span aria-hidden="true">{done ? '✅' : '⬜'}</span> {done ? t('hbDoneToday') : t('hbMarkDone')}
                  </button>
                ) : (
                  <input className="field" type="number" inputMode="decimal" min="0" max={habitMax(habit)} step="any" aria-label={name} value={drafts[habit.id] ?? ''} onChange={(event) => typeValue(habit, event.target.value)} />
                )}
                <ProgressBar value={percent} color={habit.color} />
                <div className="habit-goal-meta">
                  <span>{t('dailyGoal')}: {goalText(habit)}</span>
                  <strong>{percent}%</strong>
                </div>
                {!boolean && (
                  <Button variant="secondary" size="small" type="button" onClick={() => typeValue(habit, addQuickAmount(habit, drafts[habit.id]))}>
                    + {Number(habit.quick_add).toLocaleString(locale)} {unit || t('steps')}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        <Button variant="primary" type="submit" disabled={saving || dirty.length === 0}>{saving ? t('savingHabits') : t('saveHabits')}</Button>

        {archived.length > 0 && (
          <details className="habit-archived">
            <summary>{fillText(t('hbArchivedTitle'), { n: archived.length })}</summary>
            <ul>
              {archived.map((habit) => (
                <li key={habit.id}>
                  <span><span className={`habit-dot habit-dot-${habit.color}`} aria-hidden="true" /> <strong dir="auto">{habitName(habit, t)}</strong> <small>{goalText(habit)}</small></span>
                  <span className="habit-card-actions">
                    <button type="button" className="text-action" onClick={() => restoreHabit(habit)}>{t('hbRestore')}</button>
                    <button type="button" className="icon-button" onClick={() => setModal({ type: 'remove', habit })} aria-label={`${t('hbRemove')}: ${habitName(habit, t)}`} title={t('hbRemove')}>🗑️</button>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </form>

      <section className="panel client-habit-history">
        <div className="panel-heading"><div><span className="eyebrow">{t('habitTracker')}</span><h3>{t('habitHistory')}</h3></div></div>
        {status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {status === 'ready' && active.length === 0 && <div className="empty-state">{t('noHabitHistory')}</div>}
        {status === 'ready' && active.map((habit) => (
          <HabitWeekChart key={habit.id} habit={habit} valuesByDate={values[habit.id]} days={days} streak={calculateStreak(habit, values[habit.id], today)} />
        ))}
      </section>

      {modal?.type === 'edit' && <HabitEditorModal initial={modal.initial} onSave={submitHabit} onClose={() => setModal(null)} />}
      {modal?.type === 'remove' && <HabitRemoveModal habit={modal.habit} onArchive={() => archiveHabit(modal.habit)} onDelete={() => removeHabit(modal.habit)} onClose={() => setModal(null)} />}
    </div>
  );
}
