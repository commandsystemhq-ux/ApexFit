import { useEffect, useRef, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getExerciseVideoSource } from '../services/exerciseCatalogUtils.js';

function ExerciseDemoDialog({ exercise, onClose }) {
  const closeButton = useRef(null);
  const source = getExerciseVideoSource(exercise.demo_video_url);
  const { t } = useLocale();

  useEffect(() => {
    closeButton.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="video-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="video-dialog" role="dialog" aria-modal="true" aria-label={exercise.name}>
        <div className="video-dialog-heading">
          <h2>{exercise.name}</h2>
          <button ref={closeButton} className="icon-button" type="button" onClick={onClose} aria-label={t('close')}>×</button>
        </div>
        {source?.kind === 'iframe' && (
          <iframe
            className="exercise-video"
            src={source.src}
            title={exercise.name}
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}
        {source?.kind === 'video' && (
          <video className="exercise-video" src={source.src} controls playsInline>
            {t('videoUnsupported')}
          </video>
        )}
      </section>
    </div>
  );
}

export default function ExerciseCard({ exercise, onAdd, addLabel }) {
  const [demoOpen, setDemoOpen] = useState(false);
  const { t } = useLocale();
  const videoSource = getExerciseVideoSource(exercise.demo_video_url);

  return (
    <article className="exercise-card">
      <div className="exercise-card-heading">
        <h3>{exercise.name}</h3>
        <span className="soft-badge badge-blue">{t(`category_${exercise.category}`)}</span>
      </div>
      {exercise.thumbnail_url && (
        <img
          className="exercise-thumbnail"
          src={exercise.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
      <div className="exercise-card-meta">
        <span>{t(`difficulty_${exercise.difficulty}`)}</span>
        {(exercise.equipment || []).map((item) => <span key={item}>{t(`equipment_${item}`)}</span>)}
      </div>
      <div className="exercise-card-muscles">
        {(exercise.primary_muscles || []).map((muscle) => <span key={muscle}>{t(`muscle_${muscle}`)}</span>)}
      </div>
      {exercise.instructions?.length > 0 && (
        <details className="exercise-instructions">
          <summary>{t('exerciseInstructions')}</summary>
          <ol>{exercise.instructions.map((instruction, index) => <li key={`${index}-${instruction}`}>{instruction}</li>)}</ol>
        </details>
      )}
      <div className="exercise-card-actions">
        {videoSource
          ? <Button variant="secondary" size="small" type="button" onClick={() => setDemoOpen(true)}>{t('demoVideo')}</Button>
          : exercise.demo_video_url && <span className="muted-copy">{t('videoUnavailable')}</span>}
        {onAdd && <Button variant="primary" size="small" type="button" onClick={() => onAdd(exercise)}>{addLabel || t('addExercise')}</Button>}
      </div>
      {demoOpen && <ExerciseDemoDialog exercise={exercise} onClose={() => setDemoOpen(false)} />}
    </article>
  );
}
