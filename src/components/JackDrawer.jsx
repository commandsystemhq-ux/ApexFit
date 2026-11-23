import { useEffect, useRef } from 'react';
import JackHistory from './JackHistory.jsx';
import JackIcon from './JackIcon.jsx';
import JackMealCard from './JackMealCard.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PAGES } from '../routes.js';
import { IMAGE_TYPES } from '../services/jackImage.js';
import { mealFromStep } from '../services/jackUtils.js';

function StepRow({ step, t }) {
  const label = t(`jackTool_${step.tool}_${step.status === 'running' ? 'running' : 'done'}`);
  const page = step.tool === 'navigate_to' && step.detail?.page ? PAGES[step.detail.page] : null;
  return (
    <li className={`jack-step is-${step.status}`}>
      <span className="jack-step-icon" aria-hidden="true">{step.status === 'running' ? '' : step.status === 'done' ? '\u2713' : '!'}</span>
      <span className="jack-step-copy">
        {step.status === 'error' ? t('jackStepFailed') : label}
        {step.status === 'done' && page ? `: ${t(page.titleKey)}` : ''}
        {step.status === 'error' && step.detail?.error && <small>{step.detail.error}</small>}
      </span>
    </li>
  );
}

export default function JackDrawer({
  open, role, messages, busy, draft, onDraftChange, onSend, onClose, onNewChat, prompts, notice,
  view, onViewChange, history, onOpenConversation, onDeleteConversation, activeConversationId,
  photo, photoError, onPickPhoto, onClearPhoto, onSaveMeal, onOpenPage,
}) {
  const { t } = useLocale();
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const canAttach = role === 'client';
  const showingHistory = view === 'history';

  useEffect(() => {
    if (open && !showingHistory) inputRef.current?.focus();
  }, [open, showingHistory]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, open, showingHistory]);

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

  function handleFile(event) {
    const [file] = event.target.files || [];
    event.target.value = '';
    if (file) onPickPhoto(file);
  }

  const canSend = !busy && (draft.trim() || photo);

  return (
    <aside className={`jack-drawer ${open ? 'is-open' : ''}`} role="dialog" aria-label={t('jackTitle')} aria-hidden={!open} inert={!open}>
      <header className="jack-header">
        <span className="jack-avatar"><JackIcon size={22} /></span>
        <div className="jack-header-copy">
          <strong>{showingHistory ? t('jackHistoryTitle') : t('jackTitle')}</strong>
          <small>{showingHistory ? t('jackHistorySubtitle') : t('jackSubtitle')}</small>
        </div>
        <button
          className={`jack-icon-button ${showingHistory ? 'is-active' : ''}`}
          type="button"
          onClick={() => onViewChange(showingHistory ? 'chat' : 'history')}
          title={showingHistory ? t('jackBackToChat') : t('jackHistory')}
          aria-label={showingHistory ? t('jackBackToChat') : t('jackHistory')}
          aria-pressed={showingHistory}
        >{showingHistory ? '\u2190' : '\u{1F552}'}</button>
        <button className="jack-icon-button" type="button" onClick={onNewChat} disabled={busy} title={t('jackNewChat')} aria-label={t('jackNewChat')}>{'\u270E'}</button>
        <button className="jack-icon-button" type="button" onClick={onClose} title={t('jackClose')} aria-label={t('jackClose')}>{'\u2715'}</button>
      </header>

      {showingHistory ? (
        <JackHistory history={history} activeId={activeConversationId} onOpen={onOpenConversation} onDelete={onDeleteConversation} onNewChat={onNewChat} />
      ) : (
        <>
          <div className="jack-messages" ref={listRef} aria-live="polite">
            {messages.length === 0 && (
              <div className="jack-welcome">
                <span className="jack-avatar jack-avatar-large"><JackIcon size={34} /></span>
                <p>{t(role === 'client' ? 'jackGreetingClient' : role === 'trainer' ? 'jackGreetingTrainer' : 'jackGreetingCoach')}</p>
                {canAttach && <p className="jack-welcome-hint">{'\u{1F4F7}'} {t('jackPhotoHint')}</p>}
              </div>
            )}
            {messages.map((message) => (
              <div className={`jack-message jack-message-${message.role}`} key={message.id}>
                {message.role === 'assistant' && message.steps.length > 0 && (
                  <ul className="jack-steps">
                    {message.steps.map((step) => <StepRow key={step.id} step={step} t={t} />)}
                  </ul>
                )}
                {message.role === 'user' && message.hasImage && (
                  <div className="jack-photo-sent">
                    {message.previewUrl ? <img src={message.previewUrl} alt={t('jackPhotoAlt')} /> : <span>{'\u{1F4F7}'} {t('jackPhotoSent')}</span>}
                  </div>
                )}
                {message.text && <div className="jack-bubble" dir="auto">{message.text}</div>}
                {message.role === 'assistant' && message.steps.map((step) => {
                  const meal = mealFromStep(step);
                  return meal ? (
                    <JackMealCard key={`meal-${step.id}`} meal={meal} saved={Boolean(step.saved)} onSave={(entry) => onSaveMeal(entry, message.id, step.id)} />
                  ) : null;
                })}
                {message.role === 'assistant' && message.pending && !message.text && (
                  <div className="jack-bubble jack-typing" role="status">{t('jackThinking')}<span className="jack-dots" aria-hidden="true"><i /><i /><i /></span></div>
                )}
                {message.error && <div className="jack-bubble jack-bubble-error" role="alert">{message.error}</div>}
              </div>
            ))}
          </div>

          <footer className="jack-footer">
            {notice && <div className="notice notice-error jack-notice" role="alert">{notice}</div>}
            {photoError && <div className="notice notice-error jack-notice" role="alert">{photoError}</div>}
            {role === 'coach' && onOpenPage && (
              <div className="jack-tools" aria-label={t('jaToolsLabel')}>
                <button className="jack-chip" type="button" onClick={() => onOpenPage('/generator')}>{'\u2726'} {t('jaToolPlan')}</button>
                <button className="jack-chip" type="button" onClick={() => onOpenPage('/clients')}>{t('jaToolClients')}</button>
              </div>
            )}
            {!busy && !photo && prompts.length > 0 && (
              <div className="jack-prompts" aria-label={t('jackSuggestions')}>
                {prompts.map((key) => (
                  <button className="jack-chip" type="button" key={key} onClick={() => onSend(t(key))}>{t(key)}</button>
                ))}
              </div>
            )}
            {photo && (
              <div className="jack-photo-preview">
                <img src={photo.previewUrl} alt={t('jackPhotoAlt')} />
                <span>{t('jackPhotoReady')}</span>
                <button className="jack-icon-button" type="button" onClick={onClearPhoto} title={t('jackPhotoRemove')} aria-label={t('jackPhotoRemove')}>{'\u2715'}</button>
              </div>
            )}
            <form className="jack-form" onSubmit={(event) => { event.preventDefault(); onSend(draft); }}>
              {canAttach && (
                <>
                  <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={handleFile} data-testid="jack-photo-input" />
                  <button className="jack-attach" type="button" disabled={busy} onClick={() => fileRef.current?.click()} title={t('jackAttach')} aria-label={t('jackAttach')}>{'\u{1F4F7}'}</button>
                </>
              )}
              <textarea
                ref={inputRef}
                className="jack-input"
                rows={1}
                value={draft}
                maxLength={2000}
                placeholder={t(photo ? 'jackPhotoPlaceholder' : 'jackPlaceholder')}
                aria-label={t('jackPlaceholder')}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button className="jack-send" type="submit" disabled={!canSend} aria-label={t('jackSend')} title={t('jackSend')}>{'\u27A4'}</button>
            </form>
          </footer>
        </>
      )}
    </aside>
  );
}