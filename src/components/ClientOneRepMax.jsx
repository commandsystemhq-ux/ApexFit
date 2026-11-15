import { useEffect, useState } from 'react';
import ProgressLineChart from './ProgressLineChart.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getOneRepMaxHistory } from '../services/clientStrengthService.js';

export default function ClientOneRepMax() {
  const { locale, t } = useLocale();
  const [exercises, setExercises] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getOneRepMaxHistory()
      .then((result) => {
        if (!active) return;
        setExercises(result);
        setSelectedId(result[0]?.exerciseId || '');
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const selected = exercises.find((exercise) => exercise.exerciseId === selectedId) || null;
  const formatDate = (date) => new Date(`${date}T12:00:00`).toLocaleDateString(locale);

  return (
    <div className="client-progress-layout">
      <section className="panel strength-panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('strengthTab')}</span><h3>{t('strengthTitle')}</h3></div></div>
        <p className="muted-copy">{t('strengthDescription')}</p>
        {error && <div className="notice notice-error" role="alert">{t('strengthLoadError')} {error}</div>}
        {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!loading && !error && exercises.length === 0 && <div className="empty-state">{t('strengthNone')}</div>}
        {selected && (
          <>
            <label className="form-label">{t('strengthSelect')}
              <select className="field" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                {exercises.map((exercise) => <option key={exercise.exerciseId} value={exercise.exerciseId}>{exercise.name}</option>)}
              </select>
            </label>
            <dl className="strength-stats">
              <div><dt>{t('strengthBest')}</dt><dd>{selected.best.estimated_one_rep_max} kg</dd></div>
              <div><dt>{t('strengthLatest')}</dt><dd>{selected.latest.estimated_one_rep_max} kg</dd></div>
              <div><dt>{t('strengthChange')}</dt><dd>{selected.change > 0 ? '+' : ''}{selected.change} kg</dd></div>
            </dl>
            <ProgressLineChart
              data={selected.records.map((record) => ({ measured_on: record.workout_date, estimated_one_rep_max: record.estimated_one_rep_max }))}
              field="estimated_one_rep_max"
              title={`${selected.name} · ${t('strengthChartTitle')}`}
              color="#f0b44c"
              unit=" kg"
            />
          </>
        )}
      </section>

      <section className="panel strength-records-panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('strengthTab')}</span><h3>{t('strengthRecords')}</h3></div></div>
        {!loading && exercises.length === 0 && <div className="empty-state">{t('strengthNone')}</div>}
        {exercises.length > 0 && (
          <div className="strength-record-list">
            {exercises.map((exercise) => (
              <button
                type="button"
                key={exercise.exerciseId}
                className={`strength-record ${exercise.exerciseId === selectedId ? 'is-selected' : ''}`}
                aria-pressed={exercise.exerciseId === selectedId}
                onClick={() => setSelectedId(exercise.exerciseId)}
              >
                <strong>{exercise.name}</strong>
                <span className="strength-record-value">{exercise.best.estimated_one_rep_max} kg</span>
                <small>{t('strengthBasedOn')}: {exercise.best.top_weight_kg} kg × {exercise.best.top_reps} · {formatDate(exercise.best.workout_date)}</small>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
