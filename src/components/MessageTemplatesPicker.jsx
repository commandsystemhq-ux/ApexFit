import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMessageTemplates } from '../services/messageTemplateService.js';
import { TEMPLATE_CATEGORY_KEYS, applyTemplate, groupTemplates } from '../services/messageTemplateUtils.js';

// The coach's ready-made messages next to the chat box. Choosing one puts its text in the box with {client_name}
// replaced by the name of the person they are talking to; the coach can still change it before sending.
export default function MessageTemplatesPicker({ clientName, onPick }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: 'idle', items: [], error: '' });
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setState((current) => ({ ...current, status: 'loading' }));
    listMessageTemplates()
      .then((items) => active && setState({ status: 'ready', items, error: '' }))
      .catch((error) => active && setState({ status: 'error', items: [], error: error.message }));
    const onPointer = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      active = false;
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = groupTemplates(state.items);

  return (
    <div className="template-picker" ref={rootRef}>
      <button className="chat-tool" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open} aria-label={t('tplInsert')} title={t('tplInsert')}>
        <span aria-hidden="true">{'\u26A1'}</span>
      </button>
      {open && (
        <div className="template-menu" role="listbox" aria-label={t('tplInsert')}>
          {state.status === 'loading' && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
          {state.status === 'error' && <p className="field-error" role="alert">{state.error}</p>}
          {state.status === 'ready' && groups.length === 0 && <p className="muted-copy">{t('tplNoneYet')}</p>}
          {groups.map((group) => (
            <div className="template-group" key={group.category}>
              <span className="template-group-title">{t(TEMPLATE_CATEGORY_KEYS[group.category])}</span>
              {group.items.map((item) => (
                <button className="template-item" type="button" role="option" key={item.id} onClick={() => { onPick(applyTemplate(item, clientName)); setOpen(false); }}>
                  <strong dir="auto">{item.title}</strong>
                  <small dir="auto">{applyTemplate(item, clientName)}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
