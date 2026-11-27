import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import ChatWorkspace from '../components/ChatWorkspace.jsx';
import MessageTemplatesManager from '../components/MessageTemplatesManager.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel, groupSentMessages } from '../services/coachingUtils.js';
import { listSentMessages, sendCoachMessage } from '../services/messageService.js';

// One-way notes and videos to one client or to everyone at once.
function BroadcastPanel({ onNavigate }) {
  const { locale, t } = useLocale();
  const [clients, setClients] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [audience, setAudience] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [body, setBody] = useState('');
  const [videoFile, setVideoFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [success, setSuccess] = useState('');
  const fileInput = useRef(null);

  async function refresh() {
    try {
      const [clientRows, messageRows] = await Promise.all([listMyClients(), listSentMessages()]);
      setClients(clientRows.filter((client) => client.status === 'active'));
      setHistory(groupSentMessages(messageRows));
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function toggleClient(clientId) {
    setSelectedIds((current) => (
      current.includes(clientId) ? current.filter((id) => id !== clientId) : [...current, clientId]
    ));
  }

  async function handleSend(event) {
    event.preventDefault();
    setSendError('');
    setSuccess('');
    setSending(true);
    try {
      const result = await sendCoachMessage({
        clientIds: selectedIds,
        sendToAll: audience === 'all',
        body,
        videoFile,
      });
      setBody('');
      setVideoFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setSuccess(`${t('messageSent')} (${result.recipient_count})`);
      await refresh();
    } catch (error) {
      setSendError(`${t('messageSendError')} ${error.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {loadError && <div className="notice notice-error" role="alert">{t('messagesLoadError')} {loadError}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !loadError && clients.length === 0 && (
        <section className="panel">
          <div className="dashboard-empty">
            <h3>{t('emptyClients')}</h3>
            <p>{t('messagesNeedClients')}</p>
            <Button variant="primary" onClick={() => onNavigate('clients')}>{t('inviteClient')}</Button>
          </div>
        </section>
      )}
      {clients.length > 0 && (
        <div className="client-feature-grid">
          <form className="panel message-composer" onSubmit={handleSend}>
            <div className="panel-heading"><div><span className="eyebrow">{t('messages')}</span><h3>{t('composeMessage')}</h3></div></div>
            <fieldset className="audience-picker">
              <legend>{t('messageRecipients')}</legend>
              <label className="checkbox-row"><input type="radio" name="audience" checked={audience === 'all'} onChange={() => setAudience('all')} />{t('allClients')} ({clients.length})</label>
              <label className="checkbox-row"><input type="radio" name="audience" checked={audience === 'selected'} onChange={() => setAudience('selected')} />{t('selectedClients')}</label>
              {audience === 'selected' && (
                <div className="recipient-list">
                  {clients.map((client) => (
                    <label className="checkbox-row" key={client.client_id}>
                      <input type="checkbox" checked={selectedIds.includes(client.client_id)} onChange={() => toggleClient(client.client_id)} />
                      {clientLabel(client)}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <label className="form-label">{t('messageText')}
              <textarea className="field intake-textarea" maxLength={2000} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t('messagePlaceholder')} />
            </label>
            <label className="form-label">{t('attachVideo')}
              <input ref={fileInput} className="field" type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(event) => setVideoFile(event.target.files?.[0] || null)} />
            </label>
            <p className="muted-copy">{t('videoLimitHint')}</p>
            {sendError && <div className="notice notice-error" role="alert">{sendError}</div>}
            {success && <div className="notice notice-info" role="status">{success}</div>}
            <Button variant="primary" type="submit" disabled={sending}>{sending ? t('messageSending') : t('sendMessage')}</Button>
          </form>

          <section className="panel message-history">
            <div className="panel-heading"><div><span className="eyebrow">{t('messages')}</span><h3>{t('sentMessages')}</h3></div></div>
            {history.length === 0 && <div className="empty-state">{t('noSentMessages')}</div>}
            <div className="sent-list">
              {history.map((batch) => (
                <article className="sent-item" key={batch.batchId}>
                  <div className="sent-item-heading">
                    <span className="soft-badge badge-muted">{t(batch.kind === 'video' ? 'videoMessage' : 'noteMessage')}</span>
                    <time dateTime={batch.createdAt}>{new Date(batch.createdAt).toLocaleString(locale)}</time>
                  </div>
                  {batch.body && <p>{batch.body}</p>}
                  <small>{batch.recipients} {t('recipients')} · {batch.read} {t('readCount')}</small>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default function MessagesPage({ onNavigate }) {
  const { t } = useLocale();
  const [params] = useSearchParams();
  const withClient = params.get('with');
  const [tab, setTab] = useState('chats');
  const tabs = [{ id: 'chats', label: 'chatTab' }, { id: 'broadcast', label: 'chatBroadcastTab' }, { id: 'templates', label: 'tplTab' }];

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('messagesTitle')} description={t('messagesDescription')} />
      <nav className="client-feature-tabs" aria-label={t('messagesTitle')}>
        {tabs.map((item) => (
          <button key={item.id} className={`client-feature-tab ${tab === item.id ? 'is-active' : ''}`} type="button" aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>
            {t(item.label)}
          </button>
        ))}
      </nav>
      {tab === 'chats' && (
        <ChatWorkspace
          initialPartnerId={withClient}
          emptyState={(
            <section className="panel">
              <div className="dashboard-empty">
                <h3>{t('emptyClients')}</h3>
                <p>{t('messagesNeedClients')}</p>
                <Button variant="primary" onClick={() => onNavigate('clients')}>{t('inviteClient')}</Button>
              </div>
            </section>
          )}
        />
      )}
      {tab === 'broadcast' && <BroadcastPanel onNavigate={onNavigate} />}
      {tab === 'templates' && <MessageTemplatesManager />}
    </>
  );
}
