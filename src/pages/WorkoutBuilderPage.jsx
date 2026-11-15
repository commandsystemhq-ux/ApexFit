import { useEffect, useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import ExerciseCard from '../components/ExerciseCard.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { searchExercises } from '../services/exerciseService.js';
import { getWorkoutProgram, listMyWorkoutPrograms, saveWorkoutProgram } from '../services/workoutProgramService.js';

const PICKER_PAGE_SIZE = 8;

function createDay(label, index) {
  return { clientId: crypto.randomUUID(), name: `${label} ${index}`, exercises: [] };
}

function createProgramExercise(exercise) {
  return {
    clientId: crypto.randomUUID(),
    exercise_id: exercise.id,
    exercise,
    sets: '3',
    reps: '8-12',
    rest_seconds: '90',
    notes: '',
  };
}

export default function WorkoutBuilderPage({ onNotify }) {
  const { t } = useLocale();
  const [programId, setProgramId] = useState(null);
  const [programs, setPrograms] = useState([]);
  const [selectedProgramId, setSelectedProgramId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [days, setDays] = useState(() => [createDay(t('day'), 1)]);
  const [activeDayId, setActiveDayId] = useState(days[0].clientId);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerExercises, setPickerExercises] = useState([]);
  const [pickerTotal, setPickerTotal] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(true);
  const [pickerError, setPickerError] = useState('');
  const [pageError, setPageError] = useState('');
  const [programsError, setProgramsError] = useState('');
  const [loadingProgram, setLoadingProgram] = useState(false);
  const [saving, setSaving] = useState(false);
  const draggedExerciseIndex = useRef(null);
  const activeDay = days.find((day) => day.clientId === activeDayId) || days[0];
  const pickerPageCount = Math.max(1, Math.ceil(pickerTotal / PICKER_PAGE_SIZE));

  useEffect(() => {
    let active = true;
    listMyWorkoutPrograms()
      .then((result) => {
        if (active) setPrograms(result);
      })
      .catch((error) => {
        if (active) setProgramsError(error.message);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setPickerLoading(true);
    setPickerError('');
    const timer = window.setTimeout(() => {
      searchExercises({ search: pickerSearch, page: pickerPage, pageSize: PICKER_PAGE_SIZE })
        .then((result) => {
          if (!active) return;
          setPickerExercises(result.exercises);
          setPickerTotal(result.total);
        })
        .catch((error) => {
          if (!active) return;
          setPickerError(error.message);
          setPickerExercises([]);
          setPickerTotal(0);
        })
        .finally(() => {
          if (active) setPickerLoading(false);
        });
    }, pickerSearch ? 250 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [pickerSearch, pickerPage]);

  function addDay() {
    if (days.length >= 14) return;
    const newDay = createDay(t('day'), days.length + 1);
    setDays((current) => [...current, newDay]);
    setActiveDayId(newDay.clientId);
  }

  function startNewProgram() {
    const newDay = createDay(t('day'), 1);
    setProgramId(null);
    setSelectedProgramId('');
    setTitle('');
    setDescription('');
    setDays([newDay]);
    setActiveDayId(newDay.clientId);
    setPageError('');
  }

  function removeDay(dayId) {
    if (days.length <= 1) return;
    const nextDays = days.filter((day) => day.clientId !== dayId);
    setDays(nextDays);
    if (activeDayId === dayId) setActiveDayId(nextDays[0].clientId);
  }

  function moveDay(dayIndex, direction) {
    const nextIndex = dayIndex + direction;
    if (nextIndex < 0 || nextIndex >= days.length) return;
    setDays((current) => {
      const reordered = [...current];
      [reordered[dayIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[dayIndex]];
      return reordered;
    });
  }

  function addExercise(exercise) {
    setDays((current) => current.map((day) => (
      day.clientId === activeDayId
        ? { ...day, exercises: [...day.exercises, createProgramExercise(exercise)] }
        : day
    )));
  }

  function updateExercise(exerciseId, field, value) {
    setDays((current) => current.map((day) => (
      day.clientId === activeDayId
        ? {
          ...day,
          exercises: day.exercises.map((exercise) => (
            exercise.clientId === exerciseId ? { ...exercise, [field]: value } : exercise
          )),
        }
        : day
    )));
  }

  function removeExercise(exerciseId) {
    setDays((current) => current.map((day) => (
      day.clientId === activeDayId
        ? { ...day, exercises: day.exercises.filter((exercise) => exercise.clientId !== exerciseId) }
        : day
    )));
  }

  function moveExercise(dayId, fromIndex, toIndex) {
    if (fromIndex === null || fromIndex === toIndex) return;
    setDays((current) => current.map((day) => {
      if (day.clientId !== dayId || toIndex < 0 || toIndex >= day.exercises.length) return day;
      const reordered = [...day.exercises];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      return { ...day, exercises: reordered };
    }));
  }

  async function loadSelectedProgram() {
    if (!selectedProgramId) return;
    setLoadingProgram(true);
    setPageError('');
    try {
      const program = await getWorkoutProgram(selectedProgramId);
      const loadedDays = program.days.map((day) => ({
        clientId: crypto.randomUUID(),
        name: day.name,
        exercises: day.exercises.map((exercise) => ({
          clientId: crypto.randomUUID(),
          exercise_id: exercise.exercise_id,
          exercise: exercise.exercise,
          sets: String(exercise.sets),
          reps: exercise.reps,
          rest_seconds: String(exercise.rest_seconds),
          notes: exercise.notes,
        })),
      }));
      setProgramId(program.id);
      setTitle(program.title);
      setDescription(program.description);
      setDays(loadedDays);
      setActiveDayId(loadedDays[0].clientId);
    } catch (error) {
      setPageError(`${t('loadProgramError')} ${error.message}`);
    } finally {
      setLoadingProgram(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    setPageError('');
    if (!title.trim()) {
      setPageError(t('programTitleRequired'));
      return;
    }
    setSaving(true);
    try {
      const savedId = await saveWorkoutProgram({
        id: programId,
        title: title.trim(),
        description: description.trim(),
        days: days.map((day) => ({
          name: day.name.trim(),
          exercises: day.exercises.map((exercise) => ({
            exercise_id: exercise.exercise_id,
            sets: exercise.sets,
            reps: exercise.reps,
            rest_seconds: exercise.rest_seconds,
            notes: exercise.notes,
          })),
        })),
      });
      setProgramId(savedId);
      setSelectedProgramId(savedId);
      setPrograms((current) => [
        { id: savedId, title: title.trim(), description: description.trim(), status: 'draft', updated_at: new Date().toISOString() },
        ...current.filter((program) => program.id !== savedId),
      ]);
      onNotify(t('programSaved'));
    } catch (error) {
      setPageError(`${t('saveProgramError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('workoutBuilder')} description={t('workoutBuilderDescription')} />
      <div className="workout-builder-layout">
        <form className="panel workout-editor" onSubmit={handleSave}>
          <div className="workout-editor-heading">
            <div>
              <span className="eyebrow">{t('programDetails')}</span>
              <h3>{programId ? t('editProgram') : t('newProgram')}</h3>
            </div>
            <div className="workout-heading-actions">
              <Button variant="secondary" size="small" type="button" onClick={startNewProgram}>{t('startNewProgram')}</Button>
              <span className="soft-badge badge-muted">{days.length} / 14 {t('days')}</span>
            </div>
          </div>
          {programs.length > 0 && (
            <div className="load-program-row">
              <label className="form-label">
                {t('savedPrograms')}
                <select className="field" value={selectedProgramId} onChange={(event) => setSelectedProgramId(event.target.value)}>
                  <option value="">{t('selectProgram')}</option>
                  {programs.map((program) => <option key={program.id} value={program.id}>{program.title}</option>)}
                </select>
              </label>
              <Button variant="secondary" size="small" type="button" disabled={!selectedProgramId || loadingProgram} onClick={loadSelectedProgram}>
                {loadingProgram ? t('loadingProgram') : t('loadProgram')}
              </Button>
            </div>
          )}
          {programsError && <div className="notice notice-error" role="alert">{t('programLoadError')} {programsError}</div>}
          <label className="form-label">{t('programTitle')}<input className="field" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required /></label>
          <label className="form-label">{t('programDescription')}<textarea className="field workout-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} /></label>
          <div className="builder-days-heading">
            <strong>{t('trainingDays')}</strong>
            <Button variant="secondary" size="small" type="button" disabled={days.length >= 14} onClick={addDay}>{t('addDay')}</Button>
          </div>
          <div className="builder-day-tabs" role="group" aria-label={t('trainingDays')}>
            {days.map((day, index) => (
              <div className="builder-day-tab-wrap" key={day.clientId}>
                <button
                  type="button"
                  aria-pressed={day.clientId === activeDayId}
                  className={`day-tab ${day.clientId === activeDayId ? 'is-selected' : ''}`}
                  onClick={() => setActiveDayId(day.clientId)}
                >
                  {day.name || `${t('day')} ${index + 1}`}
                </button>
                <div className="builder-day-actions">
                  <button className="icon-button" type="button" aria-label={`${t('moveUp')} ${day.name}`} disabled={index === 0} onClick={() => moveDay(index, -1)}>↑</button>
                  <button className="icon-button" type="button" aria-label={`${t('moveDown')} ${day.name}`} disabled={index === days.length - 1} onClick={() => moveDay(index, 1)}>↓</button>
                </div>
              </div>
            ))}
          </div>
          <div className="builder-active-day">
            <div className="builder-active-day-heading">
              <label className="form-label">
                {t('dayName')}
                <input className="field" value={activeDay.name} onChange={(event) => setDays((current) => current.map((day) => day.clientId === activeDayId ? { ...day, name: event.target.value } : day))} maxLength={100} />
              </label>
              <Button variant="secondary" size="small" type="button" disabled={days.length <= 1} onClick={() => removeDay(activeDayId)}>{t('removeDay')}</Button>
            </div>
            {activeDay.exercises.length === 0
              ? <div className="dashboard-empty builder-empty"><p>{t('addExerciseHint')}</p></div>
              : (
                <div className="builder-exercise-list">
                  {activeDay.exercises.map((exercise, index) => (
                    <article
                      className="builder-exercise"
                      key={exercise.clientId}
                      draggable
                      onDragStart={(event) => {
                        draggedExerciseIndex.current = index;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', exercise.clientId);
                      }}
                      onDragEnd={() => { draggedExerciseIndex.current = null; }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        moveExercise(activeDayId, draggedExerciseIndex.current, index);
                        draggedExerciseIndex.current = null;
                      }}
                    >
                      <div className="builder-exercise-heading">
                        <span className="drag-handle" aria-hidden="true">⠿</span>
                        <strong>{exercise.exercise?.name || t('unavailableExercise')}</strong>
                        <button className="icon-button builder-remove" type="button" aria-label={`${t('removeExercise')}: ${exercise.exercise?.name || ''}`} onClick={() => removeExercise(exercise.clientId)}>×</button>
                      </div>
                      <div className="builder-exercise-fields">
                        <label className="form-label">{t('sets')}<input className="field" type="number" min="1" max="30" value={exercise.sets} onChange={(event) => updateExercise(exercise.clientId, 'sets', event.target.value)} /></label>
                        <label className="form-label">{t('reps')}<input className="field" value={exercise.reps} maxLength={50} onChange={(event) => updateExercise(exercise.clientId, 'reps', event.target.value)} /></label>
                        <label className="form-label">{t('restSeconds')}<input className="field" type="number" min="0" max="3600" value={exercise.rest_seconds} onChange={(event) => updateExercise(exercise.clientId, 'rest_seconds', event.target.value)} /></label>
                      </div>
                      <label className="form-label">{t('notes')}<input className="field" value={exercise.notes} maxLength={500} onChange={(event) => updateExercise(exercise.clientId, 'notes', event.target.value)} /></label>
                      <div className="builder-reorder-actions">
                        <button className="text-action" type="button" disabled={index === 0} onClick={() => moveExercise(activeDayId, index, index - 1)}>{t('moveUp')}</button>
                        <button className="text-action" type="button" disabled={index === activeDay.exercises.length - 1} onClick={() => moveExercise(activeDayId, index, index + 1)}>{t('moveDown')}</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
          </div>
          {pageError && <div className="notice notice-error" role="alert">{pageError}</div>}
          <Button variant="primary" type="submit" disabled={saving}>{saving ? t('savingProgram') : t('saveProgram')}</Button>
        </form>

        <section className="panel exercise-picker">
          <div className="panel-heading">
            <div><span className="eyebrow">{t('exerciseLibrary')}</span><h3>{t('addExercises')}</h3></div>
            <span className="soft-badge badge-muted">{pickerTotal}</span>
          </div>
          <label className="form-label">{t('searchExercises')}<input className="field" value={pickerSearch} onChange={(event) => { setPickerSearch(event.target.value); setPickerPage(1); }} placeholder={t('searchExercisePlaceholder')} /></label>
          {pickerError && <div className="notice notice-error" role="alert">{t('exerciseLoadError')} {pickerError}</div>}
          {pickerLoading && <div className="empty-state" role="status">{t('loadingExercises')}</div>}
          {!pickerLoading && !pickerError && pickerExercises.length === 0 && <div className="empty-state">{t('noExerciseResults')}</div>}
          {!pickerLoading && pickerExercises.length > 0 && (
            <div className="exercise-picker-list">
              {pickerExercises.map((exercise) => <ExerciseCard key={exercise.id} exercise={exercise} onAdd={addExercise} />)}
            </div>
          )}
          {pickerPageCount > 1 && (
            <nav className="pagination" aria-label={t('exerciseLibrary')}>
              <button className="button button-secondary button-small" type="button" disabled={pickerPage <= 1 || pickerLoading} onClick={() => setPickerPage((current) => current - 1)}>{t('previous')}</button>
              <span>{pickerPage} / {pickerPageCount}</span>
              <button className="button button-secondary button-small" type="button" disabled={pickerPage >= pickerPageCount || pickerLoading} onClick={() => setPickerPage((current) => current + 1)}>{t('next')}</button>
            </nav>
          )}
        </section>
      </div>
    </>
  );
}
