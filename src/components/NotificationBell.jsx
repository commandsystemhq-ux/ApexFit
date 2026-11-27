import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useNotifications } from '../hooks/useNotifications.js';
import { NOTIFICATION_ICONS, describeNotification, formatNotificationAge, safeNotificationLink, unreadLabel } from '../services/notificationUtils.js';

// The bell in the top bar: the number of unread notifications and a menu with the latest ones. Opening one marks it
// read and goes to the page it is about. Works in both reading directions (the menu opens towards the page's inner side).
export default function NotificationBell({ userId, enabled }) {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const { items, unread, status, error, markRead, markAllRead, loadMore, refresh } = useNotifications(userId, enabled);
  const [open, setOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    refresh();
    const onPointer = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, refresh]);

  if (!enabled) return null;

  function openItem(item) {
    if (!item.read_at) markRead(item.id);
    setOpen(false);
    const link = safeNotificationLink(item.link);
    if (link) navigate(link);
  }

  async function more() {
    setLoadingMore(true);
    try {
      if (!(await loadMore())) setExhausted(true);
    } catch {
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const label = unread > 0 ? `${t('notifBell')} (${unread} ${t('notifUnread')})` : t('notifBell');

  return (
    <div className="notif-root" ref={rootRef}>
      <button ref={buttonRef} className="notif-bell" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="true" aria-expanded={open} aria-label={label} title={t('notifBell')}>
        <span aria-hidden="true">{'\uD83D\uDD14'}</span>
        {unread > 0 && <span className="notif-count" aria-hidden="true">{unreadLabel(unread)}</span>}
      </button>
      {open && (
        <div className="notif-menu" role="region" aria-label={t('notifBell')}>
          <header className="notif-menu-header">
            <strong>{t('notifTitle')}</strong>
            <button className="text-action" type="button" onClick={markAllRead} disabled={unread === 0}>{t('notifMarkAll')}</button>
          </header>
          <div className="notif-list" aria-live="polite">
            {status === 'error' && items.length === 0 && <p className="notif-empty field-error" role="alert">{t('notifLoadError')} {error}</p>}
            {status !== 'error' && status !== 'ready' && <p className="notif-empty muted-copy" role="status">{t('loadingProgress')}</p>}
            {status === 'ready' && items.length === 0 && <p className="notif-empty muted-copy">{t('notifEmpty')}</p>}
            {items.map((item) => {
              const { title, body } = describeNotification(item, t, locale);
              return (
                <button key={item.id} className={`notif-item ${item.read_at ? '' : 'is-unread'}`} type="button" onClick={() => openItem(item)}>
                  <span className="notif-icon" aria-hidden="true">{NOTIFICATION_ICONS[item.type] || '\uD83D\uDD14'}</span>
                  <span className="notif-copy">
                    <strong dir="auto">{title}</strong>
                    {body && <small dir="auto">{body}</small>}
                    <time dateTime={item.created_at}>{formatNotificationAge(item.created_at, locale, new Date(), t)}</time>
                  </span>
                  {!item.read_at && <span className="notif-dot" aria-label={t('notifUnread')} />}
                </button>
              );
            })}
            {status === 'ready' && items.length >= 30 && !exhausted && (
              <button className="text-action notif-more" type="button" onClick={more} disabled={loadingMore}>{loadingMore ? t('loadingProgress') : t('notifLoadMore')}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
