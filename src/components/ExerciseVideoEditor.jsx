import { useId, useState } from 'react';
import Button from './Button.jsx';
import ExerciseVideoPlayer from './ExerciseVideoPlayer.jsx';
import { ModalShell } from './HabitModals.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { providerLabel, validateVideoLink } from '../services/exerciseVideo.js';
import { setExerciseVideo } from '../services/exerciseVideoService.js';

// The coach's own video link for one exercise: YouTube, Vimeo or an MP4/WebM link. Their clients see it instead of
// the library's video; other coaches are not affected. An empty link removes it.
export default function ExerciseVideoEditor({ exercise, onSaved, onClose }) {
  const { t } = useLocale();
  const titleId = useId();
  const own = exercise.video_origin === 'coach';
  const [text, setText] = useState(own ? exercise.demo_video_url : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const check = validateVideoLink(text);

  async function save(url) {
    setBusy(true);
    setFailure('');
    try {
      await setExerciseVideo(exercise.id, url);
      onSaved(url);
    } catch (error) {
      setFailure(`${t('evSaveError')} ${error.message}`);
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`${t('evEditTitle')}: ${exercise.name}`} titleId={titleId} onClose={onClose}>
      <form className="habit-modal-form" onSubmit={(event) => { event.preventDefault(); if (check.ok && !check.empty) save(check.value); }} noValidate>
        <label className="form-label">{t('evUrlLabel')}
          <input className="field" type="url" inputMode="url" dir="ltr" value={text} placeholder="https://www.youtube.com/watch?v=…" onChange={(event) => setText(event.target.value)} aria-invalid={!check.ok} autoFocus />
          {!check.ok && <small className="field-error" role="alert">{t(check.error)}</small>}
          {check.ok && check.provider && <small className="muted-copy">{providerLabel(check.provider)}</small>}
        </label>
        <p className="muted-copy">{t('evScope')}</p>
        {check.ok && !check.empty && (
          <div>
            <span className="eyebrow">{t('evPreview')}</span>
            <ExerciseVideoPlayer exercise={exercise} url={check.value} />
          </div>
        )}
        {failure && <div className="notice notice-error" role="alert">{failure}</div>}
        <div className="habit-modal-actions">
          {own && <Button variant="secondary" type="button" disabled={busy} onClick={() => save('')}>{t('evRemove')}</Button>}
          <Button variant="secondary" type="button" onClick={onClose}>{t('hbCancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || !check.ok || check.empty}>{busy ? t('hbSaving') : t('evSave')}</Button>
        </div>
      </form>
    </ModalShell>
  );
}