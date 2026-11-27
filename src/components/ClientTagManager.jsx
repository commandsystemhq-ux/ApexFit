import { useState } from 'react';
import Button from './Button.jsx';
import ClientTagBadge from './ClientTagBadge.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import { deleteClientTag, saveClientTag } from '../services/clientTagService.js';
import { TAG_COLORS, TAG_KINDS, emptyTagForm, missingSuggestions, validateTagForm } from '../services/clientTagUtils.js';

// Create, rename, recolour and delete the coach's tags and types.
export default function ClientTagManager({ tags, counts, onChanged }) {
  const { t } = useLocale();
  const [form, setForm] = useState(emptyTagForm);
  const [editingId, setEditingId] = useState(null);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestions = missingSuggestions(tags, (key) => t(`tgPreset_${key}`));
  const editing = tags.find((tag) => tag.id === editingId) || null;

  async function run(action) {
    setBusy(true);
    setFailure('');
    try {
      await action();
      await onChanged();
      return true;
    } catch (error) {
      setFailure(`${t('tgSaveError')} ${error.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const check = validateTagForm(form);
    setErrors(check.errors);
    if (!check.ok) return;
    if (await run(() => saveClientTag({ id: editingId, ...check.payload }))) {
      setForm(emptyTagForm());
      setEditingId(null);
    }
  }

  function edit(tag) {
    setEditingId(tag.id);
    setForm({ name: tag.name, color: tag.color, kind: tag.kind });
    setErrors({});
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyTagForm());
    setErrors({});
  }

  async function remove(tag) {
    if (!window.confirm(fillText(t('tgDeleteConfirm'), { name: tag.name }))) return;
    await run(() => deleteClientTag(tag.id));
    if (editingId === tag.id) cancelEdit();
  }

  const addSuggestions = () => run(async () => {
    for (const suggestion of suggestions) await saveClientTag({ name: suggestion.name, color: suggestion.color, kind: suggestion.kind });
  });

  return (
    <section className="panel client-tag-manager">
      <div className="panel-heading"><div><span className="eyebrow">{t('tgManage')}</span><h3>{t('tgManageTitle')}</h3></div></div>
      <p className="muted-copy">{t('tgManageHint')}</p>
      {tags.length === 0 && <div className="empty-state">{t('tgEmpty')}</div>}
      <ul className="client-tag-list">
        {tags.map((tag) => (
          <li key={tag.id}>
            <ClientTagBadge tag={tag} count={counts.get(tag.id) || 0} />
            <span className="client-tag-actions">
              <button type="button" className="text-action" disabled={busy} onClick={() => edit(tag)}>{t('ceEdit')}</button>
              <button type="button" className="text-action rpt-delete" disabled={busy} onClick={() => remove(tag)}>{t('ceDelete')}</button>
            </span>
          </li>
        ))}
      </ul>
      {suggestions.length > 0 && <Button variant="secondary" size="small" type="button" disabled={busy} onClick={addSuggestions}>{t('tgAddSuggested')}</Button>}

      <form className="client-tag-form" onSubmit={submit} noValidate>
        <h4>{editing ? t('tgEditTag') : t('tgNew')}</h4>
        <label className="form-label">{t('tgName')}
          <input className="field" value={form.name} maxLength={30} dir="auto" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} aria-invalid={Boolean(errors.name)} />
          {errors.name && <small className="field-error" role="alert">{t(errors.name)}</small>}
        </label>
        <div className="form-label">
          {t('tgKind')}
          <div className="client-tag-row" role="radiogroup" aria-label={t('tgKind')}>
            {TAG_KINDS.map((kind) => (
              <button key={kind} type="button" role="radio" aria-checked={form.kind === kind} className={`chip ${form.kind === kind ? 'is-selected' : ''}`} onClick={() => setForm((current) => ({ ...current, kind }))}>{t(`tgKind_${kind}`)}</button>
            ))}
          </div>
          <small className="muted-copy">{t('tgKindHint')}</small>
        </div>
        <div className="form-label">
          {t('tgColor')}
          <div className="client-tag-row" role="radiogroup" aria-label={t('tgColor')}>
            {TAG_COLORS.map((color) => (
              <button key={color} type="button" role="radio" aria-checked={form.color === color} aria-label={t(`tgColor_${color}`)} title={t(`tgColor_${color}`)} className={`tag-swatch tag-color-${color} ${form.color === color ? 'is-selected' : ''}`} onClick={() => setForm((current) => ({ ...current, color }))} />
            ))}
          </div>
        </div>
        {failure && <div className="notice notice-error" role="alert">{failure}</div>}
        <div className="habit-modal-actions">
          {editing && <Button variant="secondary" type="button" onClick={cancelEdit}>{t('hbCancel')}</Button>}
          <Button variant="primary" type="submit" disabled={busy}>{busy ? t('hbSaving') : t('tgSave')}</Button>
        </div>
      </form>
    </section>
  );
}
