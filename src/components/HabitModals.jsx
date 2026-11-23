import { useEffect, useId, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import {
  BUILTIN_HABITS, HABIT_COLORS, HABIT_SUGGESTIONS, MAX_HABIT_NAME, MAX_HABIT_UNIT,
  emptyHabitForm, formFromSuggestion, habitName, validateHabitForm,
} from '../services/habitUtils.js';

function ModalShell({ title, titleId, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const { t } = useLocale();
  return (
    <div className="habit-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="habit-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="habit-modal-heading">
          <h2 id={titleId} dir="auto">{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('hbClose')}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Adds a new habit (quick picks or a name of your own) or edits one: its goal, quick-add step, unit and color.
export function HabitEditorModal({ initial, onSave, onClose }) {
  const { t } = useLocale();
  const titleId = useId();
  const editing = Boolean(initial?.id);
  const builtin = BUILTIN_HABITS[initial?.builtinKey];
  const [form, setForm] = useState(initial || emptyHabitForm());
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const numeric = form.kind === 'numeric';

  async function submit(event) {
    event.preventDefault();
    const result = validateHabitForm(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setSaving(true);
    setFailure('');
    try {
      await onSave(result.payload);
    } catch (error) {
      setFailure(`${t('hbActionError')} ${error.message}`);
      setSaving(false);
    }
  }

  const fieldError = (key) => errors[key] && <small className="field-error">{t(errors[key])}</small>;

  return (
    <ModalShell title={editing ? `${t('hbModalEditTitle')}${builtin ? ` · ${habitName({ builtin_key: form.builtinKey }, t)}` : ''}` : t('hbModalAddTitle')} titleId={titleId} onClose={onClose}>
      <form className="habit-modal-form" onSubmit={submit} noValidate>
        {!editing && (
          <div className="habit-suggestions" role="group" aria-label={t('hbSuggestions')}>
            <span className="eyebrow">{t('hbSuggestions')}</span>
            <div className="habit-suggestion-list">
              {HABIT_SUGGESTIONS.map((suggestion) => (
                <button key={suggestion.id} type="button" className="choice-chip" onClick={() => { setForm(formFromSuggestion(suggestion, t)); setErrors({}); }}>
                  {t(suggestion.nameKey)}
                </button>
              ))}
            </div>
            <span className="muted-copy">{t('hbCustomName')}</span>
          </div>
        )}

        {builtin ? (
          <p className="muted-copy">{t('hbBuiltinNote')}</p>
        ) : (
          <label className="form-label">{t('hbName')}
            <input className="field" value={form.name} maxLength={MAX_HABIT_NAME} placeholder={t('hbNamePlaceholder')} onChange={(event) => update({ name: event.target.value })} aria-invalid={Boolean(errors.name)} dir="auto" autoFocus />
            {fieldError('name')}
          </label>
        )}

        {!editing && (
          <fieldset className="habit-kind-picker">
            <legend>{t('hbType')}</legend>
            {[['numeric', 'hbTypeNumeric', 'hbTypeNumericHelp'], ['boolean', 'hbTypeBoolean', 'hbTypeBooleanHelp']].map(([kind, label, help]) => (
              <label key={kind} className={`habit-kind-option ${form.kind === kind ? 'is-selected' : ''}`}>
                <input type="radio" name="habit-kind" value={kind} checked={form.kind === kind} onChange={() => update({ kind })} />
                <span><strong>{t(label)}</strong><small>{t(help)}</small></span>
              </label>
            ))}
          </fieldset>
        )}

        {numeric && (
          <div className="habit-modal-grid">
            <label className="form-label">{t('hbGoal')}
              <input className="field" type="number" inputMode="decimal" min="0" step="any" value={form.dailyGoal} onChange={(event) => update({ dailyGoal: event.target.value })} aria-invalid={Boolean(errors.dailyGoal)} />
              {fieldError('dailyGoal')}
            </label>
            {!builtin && (
              <label className="form-label">{t('hbUnit')}
                <input className="field" value={form.unit} maxLength={MAX_HABIT_UNIT} placeholder={t('hbUnitPlaceholder')} onChange={(event) => update({ unit: event.target.value })} aria-invalid={Boolean(errors.unit)} dir="auto" />
                {fieldError('unit')}
              </label>
            )}
            <label className="form-label">{t('hbQuickAdd')}
              <input className="field" type="number" inputMode="decimal" min="0" step="any" value={form.quickAdd} onChange={(event) => update({ quickAdd: event.target.value })} aria-invalid={Boolean(errors.quickAdd)} />
              {fieldError('quickAdd')}
            </label>
          </div>
        )}

        <fieldset className="habit-color-picker">
          <legend>{t('hbColor')}</legend>
          <div className="habit-swatches">
            {HABIT_COLORS.map((color) => (
              <button key={color} type="button" className={`habit-swatch habit-swatch-${color} ${form.color === color ? 'is-selected' : ''}`} aria-pressed={form.color === color} aria-label={t(`hbColor_${color}`)} title={t(`hbColor_${color}`)} onClick={() => update({ color })} />
            ))}
          </div>
          {fieldError('color')}
        </fieldset>

        {failure && <div className="notice notice-error" role="alert">{failure}</div>}
        <div className="habit-modal-actions">
          <Button variant="secondary" type="button" onClick={onClose}>{t('hbCancel')}</Button>
          <Button variant="primary" type="submit" disabled={saving}>{saving ? t('hbSaving') : t('hbSave')}</Button>
        </div>
      </form>
    </ModalShell>
  );
}

// Asks how to remove a habit: archive (the history stays) or delete it with everything logged for it.
export function HabitRemoveModal({ habit, onArchive, onDelete, onClose }) {
  const { t } = useLocale();
  const titleId = useId();
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const archived = habit.status === 'archived';

  async function run(kind, action) {
    setBusy(kind);
    setFailure('');
    try {
      await action();
    } catch (error) {
      setFailure(`${t('hbActionError')} ${error.message}`);
      setBusy('');
    }
  }

  return (
    <ModalShell title={fillText(t('hbRemoveTitle'), { name: habitName(habit, t) })} titleId={titleId} onClose={onClose}>
      <div className="habit-modal-form">
        {!archived && (
          <div className="habit-remove-option">
            <p className="muted-copy">{t('hbArchiveHelp')}</p>
            <Button variant="secondary" type="button" disabled={Boolean(busy)} onClick={() => run('archive', onArchive)}>{t('hbArchive')}</Button>
          </div>
        )}
        <div className="habit-remove-option">
          <p className="muted-copy">{t('hbDeleteHelp')}</p>
          <Button variant="danger" type="button" disabled={Boolean(busy)} onClick={() => run('delete', onDelete)}>{t('hbDelete')}</Button>
        </div>
        {failure && <div className="notice notice-error" role="alert">{failure}</div>}
        <div className="habit-modal-actions">
          <Button variant="secondary" type="button" onClick={onClose}>{t('hbCancel')}</Button>
        </div>
      </div>
    </ModalShell>
  );
}
