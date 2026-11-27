import { useId, useState } from 'react';
import Button from './Button.jsx';
import ClientTagBadge from './ClientTagBadge.jsx';
import { ModalShell } from './HabitModals.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';
import { setClientTags } from '../services/clientTagService.js';
import { MAX_TAGS_PER_CLIENT, selectionTooLarge, toggleTag } from '../services/clientTagUtils.js';

// Pick the type and the tags of one client.
export default function ClientTagEditor({ clientName, clientId, tags, initialIds, onSaved, onClose }) {
  const { t } = useLocale();
  const titleId = useId();
  const [selected, setSelected] = useState(initialIds);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const types = tags.filter((tag) => tag.kind === 'type');
  const plain = tags.filter((tag) => tag.kind === 'tag');
  const tooMany = selectionTooLarge(selected);

  async function save() {
    setBusy(true);
    setFailure('');
    try {
      await setClientTags(clientId, selected);
      onSaved(selected);
    } catch (error) {
      setFailure(`${t('tgSaveError')} ${error.message}`);
      setBusy(false);
    }
  }

  return (
    <ModalShell title={fillText(t('tgEditTitle'), { name: clientName })} titleId={titleId} onClose={onClose}>
      <div className="habit-modal-form">
        {tags.length === 0 && <p className="muted-copy">{t('tgNoTagsYet')}</p>}
        {types.length > 0 && (
          <fieldset className="chip-fieldset">
            <legend className="form-label">{t('tgKind_type')}</legend>
            <div className="client-tag-row">
              {types.map((tag) => <ClientTagBadge key={tag.id} tag={tag} selected={selected.includes(tag.id)} onClick={() => setSelected((current) => toggleTag(current, tag, tags))} />)}
            </div>
            <small className="muted-copy">{t('tgKindHint')}</small>
          </fieldset>
        )}
        {plain.length > 0 && (
          <fieldset className="chip-fieldset">
            <legend className="form-label">{t('tgKind_tag')}</legend>
            <div className="client-tag-row">
              {plain.map((tag) => <ClientTagBadge key={tag.id} tag={tag} selected={selected.includes(tag.id)} onClick={() => setSelected((current) => toggleTag(current, tag, tags))} />)}
            </div>
          </fieldset>
        )}
        {tooMany && <small className="field-error" role="alert">{fillText(t('tgErr_tooMany'), { n: MAX_TAGS_PER_CLIENT })}</small>}
        {failure && <div className="notice notice-error" role="alert">{failure}</div>}
        <div className="habit-modal-actions">
          <Button variant="secondary" type="button" onClick={onClose}>{t('hbCancel')}</Button>
          <Button variant="primary" type="button" disabled={busy || tooMany} onClick={save}>{busy ? t('hbSaving') : t('tgSave')}</Button>
        </div>
      </div>
    </ModalShell>
  );
}
