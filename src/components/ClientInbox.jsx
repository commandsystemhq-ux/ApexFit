import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMessageVideoUrl, listInboxMessages, markMessagesRead } from '../services/messageService.js';

export default function ClientInbox({ onUnreadCleared }) {
  const { locale, t } = useLocale();
  const [messages, setMessages] = useState([]);
  const [newIds, setNewIds] = useState(new Set());
  const [videoUrls, setVideoUrls] = useState({});
  const [loadingVideo, setLoadingVideo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    listInboxMessages()
      .then(async (rows) => {
        if (!active) return;
        setMessages(rows);
        const unread = rows.filter((row) => !row.read_at).map((row) => row.id);
        setNewIds(new Set(unread));
        if (unread.length > 0) {
          await markMessagesRead(unread).catch(() => null);
          onUnreadCleared?.();
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function loadVideo(message) {
    setLoadingVideo(message.id);
    try {
      const url = await getMessageVideoUrl(message.video_path);
      setVideoUrls((current) => ({ ...current, [message.id]: url }));
    } catch (videoError) {
      setError(`${t('videoLoadError')} ${videoError.message}`);
    } finally {
      setLoadingVideo('');
    }
  }

  return (
    <section className="panel client-inbox">
      <div className="panel-heading"><div><span className="eyebrow">{t('inboxTab')}</span><h3>{t('inboxTitle')}</h3></div></div>
      {error && <div className="notice notice-error" role="alert">{t('inboxLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && messages.length === 0 && <div className="empty-state">{t('inboxEmpty')}</div>}
      <div className="inbox-list">
        {messages.map((message) => (
          <article className={`inbox-item ${newIds.has(message.id) ? 'is-new' : ''}`} key={message.id}>
            <div className="sent-item-heading">
              <span className="soft-badge badge-muted">{t(message.kind === 'video' ? 'videoMessage' : 'noteMessage')}</span>
              {newIds.has(message.id) && <span className="soft-badge badge-blue">{t('newBadge')}</span>}
              <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString(locale)}</time>
            </div>
            {message.body && <p>{message.body}</p>}
            {message.kind === 'video' && (videoUrls[message.id]
              ? <video className="inbox-video" src={videoUrls[message.id]} controls playsInline preload="metadata" />
              : <Button variant="secondary" size="small" disabled={loadingVideo === message.id} onClick={() => loadVideo(message)}>{loadingVideo === message.id ? t('loadingProgress') : t('playVideo')}</Button>)}
          </article>
        ))}
      </div>
    </section>
  );
}
