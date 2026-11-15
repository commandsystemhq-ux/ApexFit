import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import ExerciseCard from './ExerciseCard.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { searchExercises } from '../services/exerciseService.js';
import { listClientWorkoutSessions, saveClientWorkout } from '../services/clientWorkoutService.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';

const EXERCISE_PAGE_SIZE = 8;

function createExerciseEntry(exercise) {
  return {
    clientId: crypto.randomUUID(),
    exercise,
    sets: Array.from({ length: 3 }, () => ({ reps: '10', weight_kg: '' })),
  };
}

function groupSessionSets(sets) {
  const grouped = new Map();
  for (const set of sets) {
    if (!grouped.has(set.exercise_order)) grouped.set(set.exercise_order, []);
    grouped.get(set.exercise_order).push(set);
  }
  return [...grouped.entries()].map(([order, exerciseSets]) => ({
    order,
    exercise: exerciseSets[0].exercise,
    sets: exerciseSets,
  }));
}

export default function ClientWorkoutLogger() {
  const { t } = useLocale();
  const today = getLocalDateString();
  const [workoutDate, setWorkoutDate] = useState(today);
  const [title, setTitle] = useState('');
  const [entries, setEntries] = useState([]);
  const [search, setSearch] = useState('');
  const [exerciseResults, setExerciseResults] = useState([]);
  const [exerciseLoading, setExerciseLoading] = useState(true);
  const [exerciseError, setExerciseError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let active = true;
    setExerciseLoading(true);
    setExerciseError('');
    const timer = window.setTimeout(() => {
      searchExercises({ search, page: 1, pageSize: EXERCISE_PAGE_SIZE })
        .then((result) => {
          if (active) setExerciseResults(result.exercises);
        })
        .catch((error) => {
          if (!active) return;
          setExerciseResults([]);
          setExerciseError(error.message);
        })
        .finally(() => {
          if (active) setExerciseLoading(false);
        });
    }, search ? 250 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  useEffect(() => {
    let active = true;
    listClientWorkoutSessions()
      .then((result) => {
        if (active) setSessions(result);
      })
      .catch((error) => {
        if (active) setHistoryError(error.message);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => { active = false; };
  }, []);

  function addExercise(exercise) {
    setEntries((current) => (
      current.some((entry) => entry.exercise.id === exercise.id)
        ? current
        : [...current, createExerciseEntry(exercise)]
    ));
    setSuccess('');
  }

  function updateSet(entryId, setIndex, field, value) {
    setEntries((current) => current.map((entry) => (
      entry.clientId === entryId
        ? {
          ...entry,
          sets: entry.sets.map((set, index) => index === setIndex ? { ...set, [field]: value } : set),
        }
        : entry
    )));
  }

  function addSet(entryId) {
    setEntries((current) => current.map((entry) => (
      entry.clientId === entryId && entry.sets.length < 30
        ? { ...entry, sets: [...entry.sets, { reps: '10', weight_kg: '' }] }
        : entry
    )));
  }

  function removeEntry(entryId) {
    setEntries((current) => current.filter((entry) => entry.clientId !== entryId));
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaveError('');
    setSuccess('');
    if (entries.length === 0) {
      setSaveError(t('addAtLeastOneExercise'));
      return;
    }

    setSaving(true);
    try {
      await saveClientWorkout({
        workoutDate,
        title: title.trim(),
        exercises: entries.map((entry) => ({
          exercise_id: entry.exercise.id,
          sets: entry.sets.map((set) => ({
            reps: Number(set.reps),
            weight_kg: set.weight_kg === '' ? null : Number(set.weight_kg),
          })),
        })),
      });
      setEntries([]);
      setTitle('');
      setSuccess(t('workoutSaved'));
      try {
        setSessions(await listClientWorkoutSessions());
        setHistoryError('');
      } catch (error) {
        setHistoryError(error.message);
      }
    } catch (error) {
      setSaveError(`${t('saveWorkoutError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="client-feature-grid">
      <form className="panel client-workout-form" onSubmit={handleSave}>
        <div className="panel-heading">
          <div><span className="eyebrow">{t('workoutLog')}</span><h3>{t('newWorkout')}</h3></div>
        </div>
        <div className="form-grid">
          <label className="form-label">{t('workoutDate')}<input className="field" type="date" value={workoutDate} max={today} onChange={(event) => setWorkoutDate(event.target.value)} required /></label>
          <label className="form-label">{t('workoutName')}<input className="field" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder={t('workoutNamePlaceholder')} required /></label>
        </div>
        <div className="client-workout-entries">
          {entries.length === 0 && <div className="dashboard-empty client-workout-empty"><p>{t('addExerciseHint')}</p></div>}
          {entries.map((entry, exerciseIndex) => (
            <article className="client-workout-entry" key={entry.clientId}>
              <header className="client-workout-entry-heading">
                <span className="soft-badge badge-muted">{exerciseIndex + 1}</span>
                <strong>{entry.exercise.name}</strong>
                <button className="icon-button builder-remove" type="button" onClick={() => removeEntry(entry.clientId)} aria-label={`${t('removeExercise')}: ${entry.exercise.name}`}>×</button>
              </header>
              <div className="client-set-list">
                {entry.sets.map((set, index) => (
                  <div className="client-set-row" key={`${entry.clientId}-${index}`}>
                    <span className="client-set-index">{t('set')} {index + 1}</span>
                    <label className="form-label">{t('actualReps')}<input className="field" type="number" min="1" max="200" value={set.reps} onChange={(event) => updateSet(entry.clientId, index, 'reps', event.target.value)} required /></label>
                    <label className="form-label">{t('actualWeight')}<input className="field" type="number" min="0" max="1000" step="0.1" value={set.weight_kg} onChange={(event) => updateSet(entry.clientId, index, 'weight_kg', event.target.value)} placeholder={t('bodyweight')} /></label>
                  </div>
                ))}
              </div>
              <Button variant="secondary" size="small" type="button" disabled={entry.sets.length >= 30} onClick={() => addSet(entry.clientId)}>{t('addSet')}</Button>
            </article>
          ))}
        </div>
        {saveError && <div className="notice notice-error" role="alert">{saveError}</div>}
        {success && <div className="notice notice-info" role="status">{success}</div>}
        <Button variant="primary" type="submit" disabled={saving}>{saving ? t('savingWorkout') : t('saveWorkout')}</Button>
      </form>

      <section className="panel client-exercise-picker">
        <div className="panel-heading"><div><span className="eyebrow">{t('exerciseLibrary')}</span><h3>{t('addExercises')}</h3></div></div>
        <label className="form-label">{t('searchExercises')}<input className="field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchExercisePlaceholder')} /></label>
        {exerciseError && <div className="notice notice-error" role="alert">{t('exerciseLoadError')} {exerciseError}</div>}
        {exerciseLoading && <div className="empty-state" role="status">{t('loadingExercises')}</div>}
        {!exerciseLoading && !exerciseError && exerciseResults.length === 0 && <div className="empty-state">{t('noExerciseResults')}</div>}
        {!exerciseLoading && exerciseResults.length > 0 && (
          <div className="exercise-picker-list">
            {exerciseResults.map((exercise) => (
              <ExerciseCard key={exercise.id} exercise={exercise} onAdd={addExercise} addLabel={t('addExercise')} />
            ))}
          </div>
        )}
      </section>

      <section className="panel client-workout-history">
        <div className="panel-heading"><div><span className="eyebrow">{t('workoutLog')}</span><h3>{t('workoutHistory')}</h3></div></div>
        {historyLoading && <div className="empty-state" role="status">{t('loadingWorkoutHistory')}</div>}
        {historyError && <div className="notice notice-error" role="alert">{t('workoutHistoryLoadError')} {historyError}</div>}
        {!historyLoading && !historyError && sessions.length === 0 && <div className="empty-state">{t('noWorkoutHistory')}</div>}
        {!historyLoading && sessions.length > 0 && (
          <div className="client-history-list">
            {sessions.map((session) => (
              <article className="client-history-item" key={session.id}>
                <div className="client-history-heading"><strong>{session.title}</strong><time dateTime={session.workout_date}>{session.workout_date}</time></div>
                {groupSessionSets(session.sets).map((group) => (
                  <div className="client-history-exercise" key={`${session.id}-${group.order}`}>
                    <strong>{group.exercise?.name || t('unavailableExercise')}</strong>
                    <span>{group.sets.map((set) => `${set.actual_reps} ${t('repetitions')}${set.actual_weight_kg === null ? '' : ` · ${set.actual_weight_kg} kg`}`).join('  /  ')}</span>
                  </div>
                ))}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
