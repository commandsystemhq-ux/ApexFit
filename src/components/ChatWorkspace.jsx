import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatConversationList from './ChatConversationList.jsx';
import ChatThread from './ChatThread.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { announceChatChanged, listConversations, subscribeToMyChat } from '../services/chatService.js';

const RELOAD_DELAY_MS = 300;
const LIST_POLL_MS = 15_000;

function createEventBus() {
  const listeners = new Set();
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      listeners.forEach((listener) => listener(event));
    },
  };
}

// The chat screen: conversations on one side, the open conversation on the other. One Realtime subscription
// serves both, so new messages show up in the open conversation and in the list without a refresh.
export default function ChatWorkspace({ initialPartnerId = null, emptyState = null }) {
  const { t } = useLocale();
  const { user, profile } = useAuth();
  const bus = useRef(null);
  if (!bus.current) bus.current = createEventBus();
  const reloadTimer = useRef(null);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(initialPartnerId);
  const [connection, setConnection] = useState('offline');
  const firstLoad = useRef(true);
  const isCoach = profile?.role === 'coach';

  const reload = useCallback(async () => {
    try {
      const rows = await listConversations();
      setConversations(rows);
      setError('');
      if (firstLoad.current) {
        firstLoad.current = false;
        setSelectedId((current) => {
          if (current && rows.some((item) => item.partner_id === current)) return current;
          return !isCoach && rows.length === 1 ? rows[0].partner_id : null;
        });
      }
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [isCoach]);

  const scheduleReload = useCallback(() => {
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(reload, RELOAD_DELAY_MS);
  }, [reload]);

  useEffect(() => {
    reload();
    return () => window.clearTimeout(reloadTimer.current);
  }, [reload]);

  useEffect(() => {
    if (!user?.id) return undefined;
    return subscribeToMyChat(user.id, {
      onMessage: (row) => {
        bus.current.emit({ type: 'message', row });
        scheduleReload();
        announceChatChanged();
      },
      onRead: (row) => bus.current.emit({ type: 'read', row }),
      onStatus: setConnection,
    });
  }, [user?.id, scheduleReload]);

  useEffect(() => {
    if (connection === 'live') return undefined;
    const timer = window.setInterval(reload, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connection, reload]);

  const selected = useMemo(() => conversations.find((item) => item.partner_id === selectedId) || null, [conversations, selectedId]);
  const partner = useMemo(() => (selected ? {
    id: selected.partner_id,
    name: selected.partner_name,
    avatarPath: selected.partner_avatar_path,
    status: selected.status,
    role: isCoach ? 'client' : 'coach',
  } : null), [selected, isCoach]);

  if (loading) return <div className="empty-state" role="status">{t('loadingProgress')}</div>;
  if (error && conversations.length === 0) return <div className="notice notice-error" role="alert">{t('chatLoadError')} {error}</div>;
  if (conversations.length === 0) return emptyState || <section className="panel"><div className="dashboard-empty"><h3>{t('chatNoConversations')}</h3></div></section>;

  const singleConversation = !isCoach && conversations.length === 1;

  return (
    <div className={`chat-workspace ${selected ? 'has-selection' : ''} ${singleConversation ? 'is-single' : ''}`}>
      {!singleConversation && (
        <ChatConversationList conversations={conversations} selectedId={selectedId} myId={user.id} onSelect={setSelectedId} />
      )}
      <div className="chat-pane">
        {partner ? (
          <ChatThread
            key={partner.id}
            partner={partner}
            myId={user.id}
            events={bus.current}
            connection={connection}
            onBack={singleConversation ? null : () => setSelectedId(null)}
            onActivity={scheduleReload}
          />
        ) : (
          <div className="chat-placeholder"><span aria-hidden="true">💬</span><p>{t('chatSelectPrompt')}</p></div>
        )}
      </div>
    </div>
  );
}
