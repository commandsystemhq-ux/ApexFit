import { useEffect, useRef } from 'react';
import JackIcon from './JackIcon.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PAGES } from '../routes.js';

function StepRow({ step, t }) {
  const label = t(`jackTool_${step.tool}_${step.status === 'running' ? 'running' : 'done'}`);
  const page = step.tool === 'navigate_to' && step.detail?.page ? PAGES[step.detail.page] : null;
  return (
    <li className={`jack-step is-${step.status}`}>
      <span className="jack-step-icon" aria-hidden="true">{step.status === 'running' ? '' : step.status === 'done' ? '✓' : '!'}</span>
      <span className="jack-step-copy">
        {step.status === 'error' ? t('jackStepFailed') : label}
        {step.status === 'done' && page ? `: ${t(page.titleKey)}` : ''}
        {step.status === 'error' && step.detail?.error && <small>{step.detail.error}</small>}
      </span>
    </li>
  );
}

export default function JackDrawer({ open, role, messages, busy, draft, onDraftChange, onSend, onClose, onReset, prompts, notice }) {
  const { t } = useLocale();
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend(draft);
    }
  }

  return (
    <aside className={`jack-drawer ${open ? 'is-open' : ''}`} role="dialog" aria-label={t('jackTitle')} aria-hidden={!open} inert={!open}>
      <header className="jack-header">
        <span className="jack-avatar"><JackIcon size={22} /></span>
        <div className="jack-header-copy">
          <strong>{t('jackTitle')}</strong>
          <small>{t('jackSubtitle')}</small>
        </div>
        <button className="jack-icon-button" type="button" onClick={onReset} disabled={busy || messages.length === 0} title={t('jackClear')} aria-label={t('jackClear')}>↺</button>
        <button className="jack-icon-button" type="button" onClick={onClose} title={t('jackClose')} aria-label={t('jackClose')}>✕</button>
      </header>

      <div className="jack-messages" ref={listRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="jack-welcome">
            <span className="jack-avatar jack-avatar-large"><JackIcon size={34} /></span>
            <p>{t(role === 'client' ? 'jackGreetingClient' : 'jackGreetingCoach')}</p>
          </div>
        )}
        {messages.map((message) => (
          <div className={`jack-message jack-message-${message.role}`} key={message.id}>
            {message.role === 'assistant' && message.steps.length > 0 && (
              <ul className="jack-steps">
                {message.steps.map((step) => <StepRow key={step.id} step={step} t={t} />)}
              </ul>
            )}
            {message.text && <div className="jack-bubble">{message.text}</div>}
            {message.role === 'assistant' && message.pending && !message.text && (
              <div className="jack-bubble jack-typing" role="status">{t('jackThinking')}<span className="jack-dots" aria-hidden="true"><i /><i /><i /></span></div>
            )}
            {message.error && <div className="jack-bubble jack-bubble-error" role="alert">{message.error}</div>}
          </div>
        ))}
      </div>

      <footer className="jack-footer">
        {notice && <div className="notice notice-error jack-notice" role="alert">{notice}</div>}
        {!busy && prompts.length > 0 && (
          <div className="jack-prompts" aria-label={t('jackSuggestions')}>
            {prompts.map((key) => (
              <button className="jack-chip" type="button" key={key} onClick={() => onSend(t(key))}>{t(key)}</button>
            ))}
          </div>
        )}
        <form className="jack-form" onSubmit={(event) => { event.preventDefault(); onSend(draft); }}>
          <textarea
            ref={inputRef}
            className="jack-input"
            rows={1}
            value={draft}
            maxLength={2000}
            placeholder={t('jackPlaceholder')}
            aria-label={t('jackPlaceholder')}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="jack-send" type="submit" disabled={busy || !draft.trim()} aria-label={t('jackSend')} title={t('jackSend')}>➤</button>
        </form>
      </footer>
    </aside>
  );
}