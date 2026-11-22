import { useMemo, useState } from 'react';
import ChatAvatar from './ChatAvatar.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { filterConversations, formatListTime } from '../services/chatUtils.js';
import { describeLastMessage } from '../services/voiceUtils.js';

export default function ChatConversationList({ conversations, selectedId, myId, onSelect }) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterConversations(conversations, query), [conversations, query]);

  return (
    <aside className="chat-list" aria-label={t('chatConversations')}>
      {conversations.length > 6 && (
        <input className="field chat-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('chatSearch')} aria-label={t('chatSearch')} />
      )}
      <ul>
        {visible.map((item) => {
          const unread = Number(item.unread_count) || 0;
          const last = describeLastMessage(item);
          const lastBody = last.voice ? `🎤 ${t('voiceMessage')}` : last.text;
          const preview = lastBody
            ? `${item.last_sender_id === myId ? `${t('chatYou')}: ` : ''}${lastBody}`
            : t('chatNoMessagesYet');
          return (
            <li key={item.partner_id}>
              <button
                type="button"
                className={`chat-list-item ${selectedId === item.partner_id ? 'is-active' : ''} ${unread ? 'has-unread' : ''}`}
                aria-current={selectedId === item.partner_id ? 'true' : undefined}
                onClick={() => onSelect(item.partner_id)}
              >
                <ChatAvatar name={item.partner_name} avatarPath={item.partner_avatar_path} />
                <span className="chat-list-copy">
                  <span className="chat-list-top">
                    <strong dir="auto">{item.partner_name}</strong>
                    <time dateTime={item.last_at || undefined}>{formatListTime(item.last_at, locale)}</time>
                  </span>
                  <span className="chat-list-bottom">
                    <span className="chat-list-preview" dir="auto">{preview}</span>
                    {unread > 0 && <span className="chat-unread" aria-label={`${unread} ${t('chatUnread')}`}>{unread > 99 ? '99+' : unread}</span>}
                  </span>
                  {item.status === 'archived' && <small className="muted-copy">{t('chatArchivedBadge')}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && <p className="muted-copy chat-list-empty">{t('chatNoResults')}</p>}
    </aside>
  );
}
