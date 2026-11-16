import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import JackDrawer from './JackDrawer.jsx';
import JackIcon from './JackIcon.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { JackRequestError, streamJack } from '../services/jackClient.js';
import {
  JACK_STORAGE_PREFIX,
  MAX_STORED_MESSAGES,
  WRITE_TOOLS,
  applyJackEvent,
  isAllowedNavigation,
  newAssistantMessage,
  quickPromptKeys,
  restoreMessages,
  toApiMessages,
} from '../services/jackUtils.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { roleOf } from '../routes.js';

export default function JackFloatingWidget({ onDataChanged }) {
  const { t, locale } = useLocale();
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const role = roleOf(profile);
  const storageKey = `${JACK_STORAGE_PREFIX}${user?.id || 'anonymous'}`;

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(() => restoreMessages(window.sessionStorage.getItem(storageKey)));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const abortRef = useRef(null);
  const counterRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    window.sessionStorage.setItem(storageKey, JSON.stringify(messages.filter((message) => !message.pending).slice(-MAX_STORED_MESSAGES)));
  }, [messages, storageKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateMessage = useCallback((id, event) => {
    setMessages((current) => current.map((message) => (message.id === id ? applyJackEvent(message, event) : message)));
  }, []);

  const send = useCallback(async (text) => {
    const content = text.trim();
    if (!content || busy) return;

    counterRef.current += 1;
    const stamp = `${Date.now()}-${counterRef.current}`;
    const assistantId = `a-${stamp}`;
    const history = [...messagesRef.current, { id: `u-${stamp}`, role: 'user', text: content }];
    setMessages([...history, newAssistantMessage(assistantId)]);
    setDraft('');
    setNotice('');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let changedData = false;

    try {
      await streamJack({
        messages: toApiMessages(history),
        context: { route: location.pathname, locale, role, userId: user?.id, today: getLocalDateString(), utcOffset: -new Date().getTimezoneOffset() },
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'navigate' && isAllowedNavigation(role, event.path)) {
            if (event.path !== window.location.pathname) navigate(event.path);
            if (window.matchMedia('(max-width: 720px)').matches) setOpen(false);
          }
          if (event.type === 'step' && event.status === 'done' && WRITE_TOOLS.includes(event.tool)) changedData = true;
          if (event.type === 'error') setNotice(event.message);
          updateMessage(assistantId, event);
        },
      });
    } catch (error) {
      if (error.name !== 'AbortError') {
        const key = error.status === 503 ? 'jackUnavailable' : error.status === 401 ? 'jackSessionError' : '';
        setNotice(key ? t(key) : error instanceof JackRequestError && error.status < 500 ? error.message : t('jackError'));
      }
    } finally {
      updateMessage(assistantId, { type: 'done' });
      setBusy(false);
      if (changedData) onDataChanged?.();
    }
  }, [busy, locale, location.pathname, navigate, onDataChanged, role, t, updateMessage, user?.id]);

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setNotice('');
    setBusy(false);
  }

  return (
    <>
      <button
        className={`jack-fab ${open ? 'is-hidden' : ''}`}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('jackOpen')}
        title={t('jackOpen')}
        aria-expanded={open}
      >
        <span className="jack-fab-glow" aria-hidden="true" />
        <JackIcon size={28} />
      </button>
      <JackDrawer
        open={open}
        role={role}
        messages={messages}
        busy={busy}
        draft={draft}
        notice={notice}
        prompts={quickPromptKeys(role, location.pathname)}
        onDraftChange={setDraft}
        onSend={send}
        onClose={() => setOpen(false)}
        onReset={reset}
      />
    </>
  );
}