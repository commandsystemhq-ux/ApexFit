import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ChatAvatar from './ChatAvatar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  CHAT_MAX_LENGTH, buildThread, dayKind, formatClock, formatFullTime, groupByDay, isNearBottom, makePendingMessage, markSentRead, mergePage,
  messageStatus, upsertMessage, validateChatText,
} from '../services/chatUtils.js';
import { announceChatChanged, getChatMessages, markChatRead, sendChatMessage } from '../services/chatService.js';
import { getMessageVideoUrl, listInboxMessages, listSentMessages, markMessagesRead } from '../services/messageService.js';

const POLL_MS = 10_000;
const STATUS_GLYPH = { sending: '◷', sent: '✓', read: '✓✓', failed: '!' };

function Bubble({ item, locale, t, onRetry, onDiscard, videoUrls, loadingVideo, onLoadVideo }) {
  const { message } = item;
  const status = item.fromMe && item.type === 'chat' ? messageStatus(message) : null;
  return (
    <div className={`chat-row ${item.fromMe ? 'is-mine' : 'is-theirs'}`}>
      <div className={`chat-bubble ${item.type !== 'chat' ? 'is-note' : ''} ${status === 'failed' ? 'is-failed' : ''}`}>
        {item.type !== 'chat' && <span className="chat-note-label">{t(item.type === 'video' ? 'chatBroadcastVideo' : 'chatBroadcastNote')}</span>}
        {item.text && <p className="chat-text" dir="auto">{item.text}</p>}
        {item.type === 'video' && (videoUrls[item.id]
          ? <video className="chat-video" src={videoUrls[item.id]} controls playsInline preload="metadata" />
          : <button className="text-action" type="button" disabled={loadingVideo === item.id} onClick={() => onLoadVideo(item)}>{loadingVideo === item.id ? t('loadingProgress') : t('playVideo')}</button>)}
        <span className="chat-meta">
          <time dateTime={item.created_at} title={formatFullTime(item.created_at, locale)}>{formatClock(item.created_at, locale)}</time>
          {status && <span className={`chat-ticks is-${status}`} aria-label={t(`chatStatus_${status}`)} title={t(`chatStatus_${status}`)}>{STATUS_GLYPH[status]}</span>}
        </span>
      </div>
      {status === 'failed' && (
        <span className="chat-failed-actions">
          <span role="alert">{t('chatSendFailed')}</span>
          <button className="text-action" type="button" onClick={() => onRetry(message)}>{t('chatRetry')}</button>
          <button className="text-action" type="button" onClick={() => onDiscard(message)}>{t('chatDiscard')}</button>
        </span>
      )}
    </div>
  );
}

// One conversation: the history, live updates, and the box to write in.
export default function ChatThread({ partner, myId, events, connection, onBack, onActivity }) {
  const { t, locale } = useLocale();
  const [chat, setChat] = useState([]);
  const [notes, setNotes] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [videoUrls, setVideoUrls] = useState({});
  const [loadingVideo, setLoadingVideo] = useState('');

  const listRef = useRef(null);
  const inputRef = useRef(null);
  const scrollPlan = useRef('bottom'); // 'bottom' | 'keep' | { height } | null
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const partnerId = partner.id;
  const isClient = partner.role === 'coach';
  const canSend = partner.status === 'active';

  const thread = useMemo(() => buildThread({ chat, notes, myId }), [chat, notes, myId]);
  const days = useMemo(() => groupByDay(thread), [thread]);

  const markRead = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      await markChatRead(partnerId);
      announceChatChanged();
      activityRef.current?.();
    } catch {
      // The next message or the next time the page is opened tries again.
    }
  }, [partnerId]);

  const loadNotes = useCallback(async () => {
    try {
      const rows = isClient ? await listInboxMessages(100) : await listSentMessages(100, partnerId);
      const mine = rows.filter((row) => (isClient ? row.coach_id === partnerId : row.client_id === partnerId));
      if (!listRef.current || isNearBottom(listRef.current, 400)) scrollPlan.current = 'bottom';
      setNotes(mine);
      if (isClient) {
        const unread = mine.filter((row) => !row.read_at).map((row) => row.id);
        if (unread.length) markMessagesRead(unread).catch(() => null);
      }
    } catch {
      setNotes([]);
    }
  }, [isClient, partnerId]);

  // Open (or switch to) a conversation.
  useEffect(() => {
    let active = true;
    setState('loading');
    setError('');
    setChat([]);
    setNotes([]);
    setDraft('');
    setDraftError('');
    scrollPlan.current = 'bottom';
    getChatMessages(partnerId)
      .then((page) => {
        if (!active) return;
        setChat(page.messages);
        setHasMore(page.hasMore);
        setState('ready');
        markRead();
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError.message);
        setState('error');
      });
    loadNotes();
    return () => { active = false; };
  }, [partnerId, loadNotes, markRead]);

  // Live updates from the workspace's single Realtime subscription.
  useEffect(() => events.on((event) => {
    const row = event.row;
    if (event.type === 'message') {
      const involvesPartner = (row.sender_id === partnerId && row.receiver_id === myId) || (row.sender_id === myId && row.receiver_id === partnerId);
      if (!involvesPartner) return;
      const wasNearBottom = !listRef.current || isNearBottom(listRef.current);
      scrollPlan.current = row.sender_id === myId || wasNearBottom ? 'bottom' : 'keep';
      setChat((current) => upsertMessage(current, row));
      if (row.sender_id === partnerId) markRead();
    } else if (event.type === 'read' && row.receiver_id === partnerId) {
      setChat((current) => markSentRead(current, [row.id]));
    }
  }), [events, partnerId, myId, markRead]);

  // Without a live connection, look for new messages every few seconds instead.
  useEffect(() => {
    if (connection === 'live' || state !== 'ready') return undefined;
    const timer = window.setInterval(async () => {
      try {
        const page = await getChatMessages(partnerId);
        scrollPlan.current = listRef.current && isNearBottom(listRef.current) ? 'bottom' : 'keep';
        setChat((current) => mergePage(current, page.messages));
        if (page.messages.some((message) => message.sender_id === partnerId && !message.is_read)) markRead();
      } catch {
        // Try again on the next tick.
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [connection, state, partnerId, markRead]);

  // A live connection that comes back may have missed messages while it was down.
  const lastConnection = useRef(connection);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    if (connection !== 'live' || previous === 'live' || state !== 'ready') return;
    getChatMessages(partnerId).then((page) => setChat((current) => mergePage(current, page.messages))).catch(() => null);
  }, [connection, state, partnerId]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') markRead(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [markRead]);

  // Scrolling after the screen has updated: newest message, or keep the place when older ones were added.
  useLayoutEffect(() => {
    const list = listRef.current;
    const plan = scrollPlan.current;
    if (!list || !plan) return;
    if (plan === 'bottom') list.scrollTop = list.scrollHeight;
    else if (typeof plan === 'object') list.scrollTop = list.scrollHeight - plan.height;
    scrollPlan.current = null;
  }, [thread.length, state, notes.length]);

  async function loadEarlier() {
    const oldest = chat[0];
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await getChatMessages(partnerId, { before: oldest.created_at });
      scrollPlan.current = { height: listRef.current ? listRef.current.scrollHeight - listRef.current.scrollTop : 0 };
      setChat((current) => mergePage(current, page.messages));
      setHasMore(page.hasMore);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function deliver(message) {
    try {
      const saved = await sendChatMessage(partnerId, message.message_text, message.client_ref);
      setChat((current) => upsertMessage(current, saved));
      activityRef.current?.();
    } catch (sendError) {
      setChat((current) => current.map((item) => (item.client_ref === message.client_ref ? { ...item, pending: false, failed: true, error: sendError.message } : item)));
    }
  }

  function send() {
    const result = validateChatText(draft);
    if (!result.valid) {
      if (result.error === 'chatErrTooLong') setDraftError(t(result.error));
      return;
    }
    setDraftError('');
    const message = makePendingMessage({ senderId: myId, receiverId: partnerId, text: result.text, clientRef: crypto.randomUUID() });
    scrollPlan.current = 'bottom';
    setChat((current) => upsertMessage(current, message));
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = '';
    deliver(message);
    inputRef.current?.focus();
  }

  function retry(message) {
    scrollPlan.current = 'bottom';
    setChat((current) => current.map((item) => (item.client_ref === message.client_ref ? { ...item, pending: true, failed: false } : item)));
    deliver(message);
  }

  const discard = (message) => setChat((current) => current.filter((item) => item.client_ref !== message.client_ref));

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  function onInput(event) {
    setDraft(event.target.value);
    setDraftError('');
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
  }

  async function loadVideo(item) {
    setLoadingVideo(item.id);
    try {
      const url = await getMessageVideoUrl(item.videoPath);
      setVideoUrls((current) => ({ ...current, [item.id]: url }));
    } catch (videoError) {
      setError(`${t('videoLoadError')} ${videoError.message}`);
    } finally {
      setLoadingVideo('');
    }
  }

  const kindLabel = (day) => {
    const kind = dayKind(day);
    return kind === 'date' ? new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : t(`chatDay_${kind}`);
  };

  return (
    <section className="chat-thread" aria-label={`${t('chatWith')} ${partner.name}`}>
      <header className="chat-thread-header">
        {onBack && <button className="chat-back" type="button" onClick={onBack} aria-label={t('chatBack')}>←</button>}
        <ChatAvatar name={partner.name} avatarPath={partner.avatarPath} />
        <div className="chat-thread-title">
          <strong dir="auto">{partner.name}</strong>
          <small className={`chat-connection is-${connection}`}>{connection === 'live' ? t('chatLive') : t('chatReconnecting')}</small>
        </div>
      </header>

      <div className="chat-messages" ref={listRef} role="log" aria-live="polite" aria-relevant="additions" aria-label={t('chatMessagesLabel')}>
        {state === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {state === 'error' && <div className="notice notice-error" role="alert">{t('chatLoadError')} {error}</div>}
        {state === 'ready' && hasMore && (
          <button className="chat-earlier" type="button" onClick={loadEarlier} disabled={loadingEarlier}>{loadingEarlier ? t('loadingProgress') : t('chatLoadEarlier')}</button>
        )}
        {state === 'ready' && thread.length === 0 && <div className="chat-empty">{t(isClient ? 'chatEmptyClient' : 'chatEmptyCoach')}</div>}
        {days.map((group) => (
          <div className="chat-day" key={group.day}>
            <span className="chat-day-label">{kindLabel(group.day)}</span>
            {group.items.map((item) => (
              <Bubble key={item.key} item={item} locale={locale} t={t} onRetry={retry} onDiscard={discard} videoUrls={videoUrls} loadingVideo={loadingVideo} onLoadVideo={loadVideo} />
            ))}
          </div>
        ))}
      </div>

      {canSend ? (
        <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={1}
            value={draft}
            maxLength={CHAT_MAX_LENGTH}
            placeholder={t('chatPlaceholder')}
            aria-label={t('chatPlaceholder')}
            dir="auto"
            onChange={onInput}
            onKeyDown={onKeyDown}
          />
          <button className="chat-send" type="submit" disabled={!draft.trim()} aria-label={t('chatSend')} title={t('chatSend')}>
            <span aria-hidden="true">➤</span>
          </button>
          {draftError && <small className="chat-composer-error" role="alert">{draftError}</small>}
          {draft.length > CHAT_MAX_LENGTH - 200 && <small className="chat-counter" dir="ltr">{draft.length}/{CHAT_MAX_LENGTH}</small>}
        </form>
      ) : (
        <div className="chat-composer-closed notice notice-info" role="status">{t(isClient ? 'chatClosedClient' : 'chatArchived')}</div>
      )}
    </section>
  );
}
