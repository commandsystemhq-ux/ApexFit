import { useEffect, useId, useState } from 'react';
import Button from './Button.jsx';
import { ModalShell } from './HabitModals.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { removeExerciseImage, saveCustomExercise, uploadExerciseImage } from '../services/customExerciseService.js';
import {
  EXERCISE_CATEGORIES, EXERCISE_DIFFICULTIES, EXERCISE_EQUIPMENT, EXERCISE_MUSCLES,
  emptyCustomExerciseForm, formFromExercise, toggleOption, validateCustomExercise, validateExerciseImage,
} from '../services/customExerciseUtils.js';

function OptionChips({ legend, options, selected, labelOf, onToggle, error, t }) {
  return (
    <fieldset className="chip-fieldset">
      <legend className="form-label">{legend}</legend>
      <div className="chip-row">
        {options.map((value) => (
          <button key={value} type="button" className={`chip ${selected.includes(value) ? 'is-selected' : ''}`} aria-pressed={selected.includes(value)} onClick={() => onToggle(value)}>
            {labelOf(value)}
          </button>
        ))}
      </div>
      {error && <small className="field-error" role="alert">{t(error)}</small>}
    </fieldset>
  );
}

// Add or edit one of the coach's own exercises. The photo is uploaded when the form is saved.
export default function CustomExerciseEditor({ exercise = null, onSaved, onClose }) {
  const { t } = useLocale();
  const titleId = useId();
  const [form, setForm] = useState(() => (exercise ? formFromExercise(exercise) : emptyCustomExerciseForm()));
  const [photo, setPhoto] = useState(null);
  const [photoRemoved, setPhotoRemoved] = useState(false);
  const [preview, setPreview] = useState(exercise?.thumbnail_url || '');
  const [photoError, setPhotoError] = useState('');
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { if (preview.startsWith('blob:')) URL.revokeObjectURL(preview); }, [preview]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  function choosePhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = validateExerciseImage(file);
    setPhotoError(problem || '');
    if (problem) return;
    setPhoto(file);
    setPhotoRemoved(false);
    setPreview(URL.createObjectURL(file));
  }

  function removePhoto() {
    setPhoto(null);
    setPhotoRemoved(true);
    setPreview('');
    setPhotoError('');
  }

  async function submit(event) {
    event.preventDefault();
    setFailure('');
    const check = validateCustomExercise(form);
    setErrors(check.errors);
    if (!check.ok) return;
    setBusy(true);
    const previousPath = exercise?.image_path || '';
    let uploadedPath = '';
    try {
      if (photo) uploadedPath = await uploadExerciseImage(photo);
      const imagePath = uploadedPath || (photoRemoved ? '' : previousPath);
      const id = await saveCustomExercise({ ...check.payload, p_image_path: imagePath }, exercise?.id ?? null);
      if (previousPath && previousPath !== imagePath) await removeExerciseImage(previousPath);
      onSaved(id);
    } catch (error) {
      if (uploadedPath) await removeExerciseImage(uploadedPath);
      setFailure(`${t('ceSaveError')} ${error.message}`);
      setBusy(false);
    }
  }

  return (
    <ModalShell title={exercise ? t('ceEditTitle') : t('ceNewTitle')} titleId={titleId} onClose={onClose}>
      <form className="habit-modal-form" onSubmit={submit} noValidate>
        <label className="form-label">{t('ceName')}
          <input className="field" value={form.name} maxLength={160} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(errors.name)} autoFocus />
          {errors.name && <small className="field-error" role="alert">{t(errors.name)}</small>}
        </label>
        <label className="form-label">{t('ceDescription')}
          <textarea className="field workout-description" value={form.description} maxLength={2000} onChange={(event) => update('description', event.target.value)} />
          {errors.description && <small className="field-error" role="alert">{t(errors.description)}</small>}
        </label>
        <div className="form-grid">
          <label className="form-label">{t('category')}
            <select className="field" value={form.category} onChange={(event) => update('category', event.target.value)}>
              {EXERCISE_CATEGORIES.map((value) => <option key={value} value={value}>{t(`category_${value}`)}</option>)}
            </select>
          </label>
          <label className="form-label">{t('difficulty')}
            <select className="field" value={form.difficulty} onChange={(event) => update('difficulty', event.target.value)}>
              {EXERCISE_DIFFICULTIES.map((value) => <option key={value} value={value}>{t(`difficulty_${value}`)}</option>)}
            </select>
          </label>
        </div>
        <OptionChips t={t} legend={t('cePrimary')} options={EXERCISE_MUSCLES} selected={form.primaryMuscles} labelOf={(value) => t(`muscle_${value}`)} onToggle={(value) => update('primaryMuscles', toggleOption(form.primaryMuscles, value))} error={errors.primaryMuscles} />
        <OptionChips t={t} legend={t('ceSecondary')} options={EXERCISE_MUSCLES.filter((value) => !form.primaryMuscles.includes(value))} selected={form.secondaryMuscles} labelOf={(value) => t(`muscle_${value}`)} onToggle={(value) => update('secondaryMuscles', toggleOption(form.secondaryMuscles, value))} error={errors.secondaryMuscles} />
        <OptionChips t={t} legend={t('equipment')} options={EXERCISE_EQUIPMENT} selected={form.equipment} labelOf={(value) => t(`equipment_${value}`)} onToggle={(value) => update('equipment', toggleOption(form.equipment, value))} error={errors.equipment} />
        <label className="form-label">{t('ceVideo')}
          <input className="field" type="url" inputMode="url" dir="ltr" value={form.videoUrl} placeholder="https://www.youtube.com/watch?v=…" onChange={(event) => update('videoUrl', event.target.value)} aria-invalid={Boolean(errors.videoUrl)} />
          {errors.videoUrl && <small className="field-error" role="alert">{t(errors.videoUrl)}</small>}
        </label>
        <div className="form-label">
          {t('cePhoto')}
          {preview && <img className="custom-exercise-photo" src={preview} alt="" />}
          <div className="habit-modal-actions">
            <label className="button button-secondary button-small">
              {t('ceChoosePhoto')}
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={choosePhoto} />
            </label>
            {preview && <Button variant="secondary" size="small" type="button" onClick={removePhoto}>{t('ceRemovePhoto')}</Button>}
          </div>
          <small className="muted-copy">{t('cePhotoHint')}</small>
          {photoError && <small className="field-error" role="alert">{t(photoError)}</small>}
        </div>
        <p className="muted-copy">{t('ceVisibility')}</p>
        {failure && <div className="notice notice-error" role="alert">{failure}</div>}
        <div className="habit-modal-actions">
          <Button variant="secondary" type="button" onClick={onClose}>{t('hbCancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? t('hbSaving') : t('ceSave')}</Button>
        </div>
      </form>
    </ModalShell>
  );
}
