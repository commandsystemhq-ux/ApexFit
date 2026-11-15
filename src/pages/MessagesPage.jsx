import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function MessagesPage() {
  const { t } = useLocale();

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('messagesTitle')} description={t('messagesDescription')} />
      <section className="messages-panel messages-empty">
        <aside className="conversation-list" aria-label={t('messagesTitle')}>
          <div className="empty-conversation-state"><span className="feature-icon feature-icon-1" aria-hidden="true">◌</span><strong>{t('emptyMessages')}</strong></div>
        </aside>
        <div className="chat-pane">
          <div className="dashboard-empty">
            <span className="feature-icon feature-icon-1" aria-hidden="true">◌</span>
            <p>{t('noConversationSelected')}</p>
          </div>
        </div>
      </section>
    </>
  );
}
