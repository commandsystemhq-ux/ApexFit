import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import JackDrawer from './JackDrawer.jsx';
import JackIcon from './JackIcon.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { addFoodLog } from '../services/clientFoodService.js';
import { deleteJackConversation, getJackConversation, listJackConversations, saveJackMessages } from '../services/jackHistoryService.js';
import { JackRequestError, streamJack } from '../services/jackClient.js';
import { photoProblem, prepareJackPhoto } from '../services/jackImage.js';
import {
  JACK_ASK_EVENT,
  JACK_STORAGE_PREFIX,
  MAX_STORED_MESSAGES,
  WRITE_TOOLS,
  applyJackEvent,
  conversationTitle,
  historyPayload,
  isAllowedNavigation,
  messagesFromConversation,
  newAssistantMessage,
  quickPromptKeys,
  restoreMessages,
  toApiMessages,
} from '../services/jackUtils.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { roleOf } from '../routes.js';

const IDLE_HISTORY = { state: 'idle', items: [] };

export default function JackFloatingWidget({ onDataChanged }) {
  const { t, locale } = useLocale();
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const role = roleOf(profile);
  const storageKey = `${JACK_STORAGE_PREFIX}${user?.id || 'anonymous'}`;
  const conversationKey = `${storageKey}.conversation`;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState('chat');
  const [messages, setMessages] = useState(() => restoreMessages(window.sessionStorage.getItem(storageKey)));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState(IDLE_HISTORY);
  const [conversationId, setConversationId] = useState(() => window.sessionStorage.getItem(conversationKey) || null);
  const [photo, setPhoto] = useState(null);
  const [photoError, setPhotoError] = useState('');
  const abortRef = useRef(null);
  const counterRef = useRef(0);
  const messagesRef = useRef(messages);
  const conversationRef = useRef(conversationId);
  const photoRef = useRef(photo);
  const sendRef = useRef(null);
  messagesRef.current = messages;
  conversationRef.current = conversationId;
  photoRef.current = photo;

  useEffect(() => {
    // Photos are not kept: only the fact that one was sent.
    const stored = messages.filter((message) => !message.pending).slice(-MAX_STORED_MESSAGES).map(({ previewUrl, ...rest }) => rest);
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
    } catch {
      // A full session storage must not break the chat.
    }
  }, [messages, storageKey]);

  useEffect(() => {
    if (conversationId) window.sessionStorage.setItem(conversationKey, conversationId);
    else window.sessionStorage.removeItem(conversationKey);
  }, [conversationId, conversationKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateMessage = useCallback((id, event) => {
    setMessages((current) => current.map((message) => (message.id === id ? applyJackEvent(message, event) : message)));
  }, []);

  const send = useCallback(async (text, { fresh = false } = {}) => {
    const attached = photoRef.current;
    const content = text.trim();
    if ((!content && !attached) || busy) return;
    const prompt = content || t('jackMealPrompt');

    counterRef.current += 1;
    const stamp = `${Date.now()}-${counterRef.current}`;
    const assistantId = `a-${stamp}`;
    const userMessage = { id: `u-${stamp}`, role: 'user', text: prompt, hasImage: Boolean(attached), previewUrl: attached?.previewUrl };
    if (fresh) setConversationId(null);
    const base = fresh ? [] : messagesRef.current;
    const conversation = fresh ? null : conversationRef.current;
    const thread = [...base, userMessage];
    setMessages([...thread, newAssistantMessage(assistantId)]);
    setDraft('');
    setNotice('');
    setPhoto(null);
    setPhotoError('');
    setView('chat');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let changedData = false;
    let answer = '';
    let failed = false;

    try {
      await streamJack({
        messages: toApiMessages(thread),
        context: { route: location.pathname, locale, role, userId: user?.id, today: getLocalDateString(), utcOffset: -new Date().getTimezoneOffset() },
        image: attached ? { mime: attached.mime, data: attached.data } : null,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'navigate' && isAllowedNavigation(role, event.path)) {
            if (event.path !== window.location.pathname) navigate(event.path);
            if (window.matchMedia('(max-width: 720px)').matches) setOpen(false);
          }
          if (event.type === 'step' && event.status === 'done' && WRITE_TOOLS.includes(event.tool)) changedData = true;
          if (event.type === 'text') answer = event.text;
          if (event.type === 'error') {
            failed = true;
            setNotice(event.message);
          }
          updateMessage(assistantId, event);
        },
      });
    } catch (error) {
      failed = true;
      if (error.name !== 'AbortError') {
        const key = error.status === 503 ? (role === 'coach' ? 'jaUnavailableCoach' : 'jackUnavailable') : error.status === 401 ? 'jackSessionError' : '';
        setNotice(key ? t(key) : error instanceof JackRequestError && error.status < 500 ? error.message : t('jackError'));
      }
    } finally {
      updateMessage(assistantId, { type: 'done' });
      setBusy(false);
      if (changedData) onDataChanged?.();
    }

    // The exchange is kept in the history. A failure here never interrupts the chat.
    if (answer && !failed) {
      try {
        const id = await saveJackMessages(conversation, conversationTitle(prompt), historyPayload(userMessage, { text: answer }));
        if (id !== conversationRef.current) setConversationId(id);
        setHistory(IDLE_HISTORY);
      } catch {
        // Best effort.
      }
    }
  }, [busy, locale, location.pathname, navigate, onDataChanged, role, t, updateMessage, user?.id]);
  sendRef.current = send;

  // Other pages can hand Jack a question (for example "write a report for Sara") and open the chat.
  useEffect(() => {
    function onAsk(event) {
      const text = typeof event.detail?.text === 'string' ? event.detail.text : '';
      if (!text) return;
      setOpen(true);
      setView('chat');
      sendRef.current?.(text, { fresh: true });
    }
    window.addEventListener(JACK_ASK_EVENT, onAsk);
    return () => window.removeEventListener(JACK_ASK_EVENT, onAsk);
  }, []);

  function newChat() {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setNotice('');
    setPhoto(null);
    setPhotoError('');
    setBusy(false);
    setView('chat');
  }

  async function loadHistory() {
    setHistory((current) => ({ ...current, state: 'loading' }));
    try {
      setHistory({ state: 'ready', items: await listJackConversations() });
    } catch {
      setHistory({ state: 'error', items: [] });
    }
  }

  function changeView(next) {
    setView(next);
    if (next === 'history') loadHistory();
  }

  async function openConversation(id) {
    try {
      const conversation = await getJackConversation(id);
      abortRef.current?.abort();
      setBusy(false);
      setMessages(messagesFromConversation(conversation));
      setConversationId(id);
      setNotice('');
      setView('chat');
    } catch {
      setHistory((current) => ({ ...current, state: 'error' }));
    }
  }

  async function removeConversation(id) {
    if (!window.confirm(t('jackHistoryDeleteConfirm'))) return;
    try {
      await deleteJackConversation(id);
      setHistory((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
      if (id === conversationRef.current) newChat();
      setView('history');
    } catch {
      setHistory((current) => ({ ...current, state: 'error' }));
    }
  }

  async function pickPhoto(file) {
    const problem = photoProblem(file);
    if (problem) {
      setPhotoError(t(problem));
      return;
    }
    try {
      setPhoto(await prepareJackPhoto(file));
      setPhotoError('');
    } catch {
      setPhotoError(t('jackPhotoError'));
    }
  }

  async function saveMeal(entry, messageId, stepId) {
    await addFoodLog({ loggedOn: getLocalDateString(), ...entry });
    setMessages((current) => current.map((message) => (message.id === messageId
      ? { ...message, steps: message.steps.map((step) => (step.id === stepId ? { ...step, saved: true } : step)) }
      : message)));
    onDataChanged?.();
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
        onNewChat={newChat}
        view={view}
        onViewChange={changeView}
        history={history}
        activeConversationId={conversationId}
        onOpenConversation={openConversation}
        onDeleteConversation={removeConversation}
        photo={photo}
        photoError={photoError}
        onPickPhoto={pickPhoto}
        onClearPhoto={() => { setPhoto(null); setPhotoError(''); }}
        onSaveMeal={saveMeal}
        onOpenPage={(path) => {
          navigate(path);
          if (window.matchMedia('(max-width: 720px)').matches) setOpen(false);
        }}
      />
    </>
  );
}