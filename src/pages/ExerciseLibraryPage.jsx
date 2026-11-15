import { useEffect, useState } from 'react';
import ExerciseCard from '../components/ExerciseCard.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { searchExercises } from '../services/exerciseService.js';

const PAGE_SIZE = 24;
const categories = ['strength', 'cardio', 'mobility', 'plyometrics', 'warmup'];
const equipmentOptions = ['barbell', 'dumbbell', 'kettlebell', 'cable', 'machine', 'resistance_band', 'bodyweight', 'medicine_ball', 'bench', 'smith_machine', 'trap_bar', 'landmine', 'plyometric_box', 'suspension_trainer', 'foam_roller', 'exercise_ball', 'other'];
const muscleOptions = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'core', 'lower_back', 'traps', 'neck', 'hip_flexors', 'adductors', 'abductors', 'full_body'];
const difficulties = ['beginner', 'intermediate', 'advanced'];

export default function ExerciseLibraryPage() {
  const { t } = useLocale();
  const [filters, setFilters] = useState({ search: '', category: '', equipment: '', muscle: '', difficulty: '' });
  const [page, setPage] = useState(1);
  const [exercises, setExercises] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      searchExercises({ ...filters, page, pageSize: PAGE_SIZE })
        .then((result) => {
          if (!active) return;
          setExercises(result.exercises);
          setTotal(result.total);
        })
        .catch((searchError) => {
          if (!active) return;
          setError(searchError.message);
          setExercises([]);
          setTotal(0);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, filters.search ? 250 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [filters, page]);

  function updateFilter(event) {
    const { name, value } = event.target;
    setFilters((current) => ({ ...current, [name]: value }));
    setPage(1);
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('exerciseLibrary')} description={t('exerciseLibraryDescription')} />
      <section className="panel library-panel">
        <div className="library-filters">
          <label className="form-label library-search">
            {t('searchExercises')}
            <input className="field" name="search" value={filters.search} onChange={updateFilter} placeholder={t('searchExercisePlaceholder')} />
          </label>
          <label className="form-label">
            {t('category')}
            <select className="field" name="category" value={filters.category} onChange={updateFilter}>
              <option value="">{t('allCategories')}</option>
              {categories.map((value) => <option key={value} value={value}>{t(`category_${value}`)}</option>)}
            </select>
          </label>
          <label className="form-label">
            {t('equipment')}
            <select className="field" name="equipment" value={filters.equipment} onChange={updateFilter}>
              <option value="">{t('allEquipment')}</option>
              {equipmentOptions.map((value) => <option key={value} value={value}>{t(`equipment_${value}`)}</option>)}
            </select>
          </label>
          <label className="form-label">
            {t('muscleGroup')}
            <select className="field" name="muscle" value={filters.muscle} onChange={updateFilter}>
              <option value="">{t('allMuscles')}</option>
              {muscleOptions.map((value) => <option key={value} value={value}>{t(`muscle_${value}`)}</option>)}
            </select>
          </label>
          <label className="form-label">
            {t('difficulty')}
            <select className="field" name="difficulty" value={filters.difficulty} onChange={updateFilter}>
              <option value="">{t('allDifficulties')}</option>
              {difficulties.map((value) => <option key={value} value={value}>{t(`difficulty_${value}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="library-results-heading">
          <span>{total} {t('exercises')}</span>
          {total > 0 && <span>{t('page')} {page} / {pageCount}</span>}
        </div>
        {error && <div className="notice notice-error" role="alert">{t('exerciseLoadError')} {error}</div>}
        {loading && <div className="empty-state" role="status">{t('loadingExercises')}</div>}
        {!loading && !error && exercises.length === 0 && (
          <div className="dashboard-empty">
            <span className="feature-icon feature-icon-1" aria-hidden="true">⌕</span>
            <p>{filters.search || filters.category || filters.equipment || filters.muscle || filters.difficulty ? t('noExerciseResults') : t('emptyExerciseLibrary')}</p>
          </div>
        )}
        {!loading && exercises.length > 0 && (
          <div className="exercise-grid">
            {exercises.map((exercise) => <ExerciseCard key={exercise.id} exercise={exercise} />)}
          </div>
        )}
        {pageCount > 1 && (
          <nav className="pagination" aria-label={t('exerciseLibrary')}>
            <button className="button button-secondary button-small" type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>{t('previous')}</button>
            <button className="button button-secondary button-small" type="button" disabled={page >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>{t('next')}</button>
          </nav>
        )}
      </section>
    </>
  );
}
