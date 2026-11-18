import { useEffect, useRef, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getExerciseVideoSource } from '../services/exerciseCatalogUtils.js';
import ExerciseMedia from './ExerciseMedia.jsx';
import { chooseMedia } from '../services/exerciseMedia.js';
import { useExerciseBundle } from '../hooks/useExerciseBundle.js';
import { displayName, localizedInstructions, localizedName, textDirection } from '../services/exerciseI18n.js';

// "Push-Up / تمرين الضغط": the English name, then the name in the chosen language. Each part keeps its own direction.
function ExerciseTitle({ exercise, locale, bundle }) {
  const local = localizedName(exercise, locale, bundle);
  return (
    <>
      <bdi dir="ltr" lang="en">{exercise.name}</bdi>
      {local && <> <span className="exercise-name-sep" aria-hidden="true">/</span> <bdi className="exercise-name-local" dir={textDirection(locale)} lang={locale}>{local}</bdi></>}
    </>
  );
}

function ExerciseDemoDialog({ exercise, onClose }) {
  const closeButton = useRef(null);
  const source = getExerciseVideoSource(exercise.demo_video_url);
  const { t, locale } = useLocale();
  const bundle = useExerciseBundle(locale);
  const fullName = displayName(exercise, locale, bundle);

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
      <section className="video-dialog" role="dialog" aria-modal="true" aria-label={fullName}>
        <div className="video-dialog-heading">
          <h2><ExerciseTitle exercise={exercise} locale={locale} bundle={bundle} /></h2>
          <button ref={closeButton} className="icon-button" type="button" onClick={onClose} aria-label={t('close')}>×</button>
        </div>
        {source?.kind === 'iframe' && (
          <iframe
            className="exercise-video"
            src={source.src}
            title={fullName}
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
        {!source && <ExerciseMedia exercise={exercise} large />}
      </section>
    </div>
  );
}

export default function ExerciseCard({ exercise, onAdd, addLabel }) {
  const [demoOpen, setDemoOpen] = useState(false);
  const { t, locale } = useLocale();
  const videoSource = getExerciseVideoSource(exercise.demo_video_url);
  const bundle = useExerciseBundle(locale);
  const steps = localizedInstructions(exercise, locale, bundle);
  const hasMotion = ['video', 'gif', 'frames'].includes(chooseMedia(exercise).mode) || Boolean(exercise.animation_url);

  return (
    <article className="exercise-card">
      <div className="exercise-card-heading">
        <h3 className="exercise-title"><ExerciseTitle exercise={exercise} locale={locale} bundle={bundle} /></h3>
        <span className="soft-badge badge-blue">{t(`category_${exercise.category}`)}</span>
      </div>
      <ExerciseMedia exercise={exercise} />
      <div className="exercise-card-meta">
        <span>{t(`difficulty_${exercise.difficulty}`)}</span>
        {(exercise.equipment || []).map((item) => <span key={item}>{t(`equipment_${item}`)}</span>)}
      </div>
      <div className="exercise-card-muscles">
        {(exercise.primary_muscles || []).map((muscle) => <span key={muscle}>{t(`muscle_${muscle}`)}</span>)}
      </div>
      {steps.steps.length > 0 && (
        <details className="exercise-instructions">
          <summary>{t('exerciseInstructions')}</summary>
          <ol dir={textDirection(steps.locale)} lang={steps.locale}>{steps.steps.map((instruction, index) => <li key={`${index}-${instruction}`}>{instruction}</li>)}</ol>
        </details>
      )}
      <div className="exercise-card-actions">
        {videoSource
          ? <Button variant="secondary" size="small" type="button" onClick={() => setDemoOpen(true)}>{t('demoVideo')}</Button>
          : exercise.demo_video_url && <span className="muted-copy">{t('videoUnavailable')}</span>}
        {!videoSource && hasMotion && <Button variant="secondary" size="small" type="button" onClick={() => setDemoOpen(true)}>{t('exerciseViewLarger')}</Button>}
        {onAdd && <Button variant="primary" size="small" type="button" onClick={() => onAdd(exercise)}>{addLabel || t('addExercise')}</Button>}
      </div>
      {demoOpen && <ExerciseDemoDialog exercise={exercise} onClose={() => setDemoOpen(false)} />}
    </article>
  );
}
