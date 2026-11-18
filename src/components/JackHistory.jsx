import { useLocale } from '../contexts/LocaleContext.jsx';
import { formatRelativeTime } from '../services/communityUtils.js';

// The list of earlier conversations with Jack. Opening one continues it; the bin removes it for good.
export default function JackHistory({ history, activeId, onOpen, onDelete, onNewChat }) {
  const { t, locale } = useLocale();

  return (
    <div className="jack-history">
      <button className="jack-history-new" type="button" onClick={onNewChat}>{'\u270E'} {t('jackNewChat')}</button>
      {history.state === 'loading' && <p className="muted-copy" role="status">{t('jackHistoryLoading')}</p>}
      {history.state === 'error' && <div className="notice notice-error" role="alert">{t('jackHistoryError')}</div>}
      {history.state === 'ready' && history.items.length === 0 && <p className="muted-copy">{t('jackHistoryEmpty')}</p>}
      <ul className="jack-history-list">
        {history.items.map((item) => (
          <li key={item.id} className={`jack-history-item ${item.id === activeId ? 'is-active' : ''}`}>
            <button className="jack-history-open" type="button" onClick={() => onOpen(item.id)}>
              <strong dir="auto">{item.title}</strong>
              <small>{formatRelativeTime(item.updated_at, locale)} {'\u00B7'} {Number(item.message_count)} {t('jackHistoryMessages')}</small>
            </button>
            <button className="jack-icon-button" type="button" onClick={() => onDelete(item.id)} title={t('jackHistoryDelete')} aria-label={`${t('jackHistoryDelete')}: ${item.title}`}>{'\u{1F5D1}\uFE0F'}</button>
          </li>
        ))}
      </ul>
      <p className="jack-history-note">{t('jackHistoryPrivacy')}</p>
    </div>
  );
}