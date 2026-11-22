import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import {
  createCampaign, getEmailStatus, listCampaignRecipients, listCampaigns, retryFailedRecipients, sendCampaignBatch,
} from '../services/campaignService.js';
import {
  CAMPAIGN_BODY_MAX, CAMPAIGN_LANGUAGES, CAMPAIGN_SUBJECT_MAX, campaignProgress, isRtlLanguage, recipientStatusKey, renderCampaignEmail, runCampaignSend,
  validateCampaignDraft,
} from '../services/campaignTemplate.js';

const LANGUAGE_NAMES = { en: 'English', ar: 'العربية', de: 'Deutsch', fr: 'Français', es: 'Español' };

function CampaignHistoryItem({ campaign, busy, onResume, onRetry, locale, t }) {
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState(null);
  const [error, setError] = useState('');
  const progress = campaignProgress(campaign);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        setRecipients(await listCampaignRecipients(campaign.id));
        setError('');
      } catch (loadError) {
        setError(loadError.message);
      }
    }
  }

  return (
    <article className="sent-item">
      <div className="sent-item-heading">
        <span className={`soft-badge ${campaign.status === 'sent' ? 'badge-green' : campaign.status === 'sending' ? 'badge-blue' : 'badge-muted'}`}>{t(`campaignStatus_${campaign.status}`)}</span>
        <time dateTime={campaign.created_at}>{new Date(campaign.created_at).toLocaleString(locale)}</time>
      </div>
      <strong dir="auto">{campaign.subject}</strong>
      <div className="campaign-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={t('campaignProgressLabel')}>
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <small>
        {t('campaignTotal')}: {campaign.total_count} · {t('campaignSentLabel')}: {campaign.sent_count} · {t('campaignFailedLabel')}: {campaign.failed_count} · {t('campaignSkippedLabel')}: {campaign.skipped_count}
      </small>
      <div className="campaign-actions">
        {campaign.status === 'sending' && <button className="text-action" type="button" disabled={busy} onClick={() => onResume(campaign.id)}>{t('campaignResume')}</button>}
        {campaign.failed_count > 0 && <button className="text-action" type="button" disabled={busy} onClick={() => onRetry(campaign.id)}>{t('campaignRetryFailed')}</button>}
        <button className="text-action" type="button" onClick={toggle}>{open ? t('campaignHideDetails') : t('campaignDetails')}</button>
      </div>
      {open && error && <div className="notice notice-error" role="alert">{error}</div>}
      {open && recipients && (
        <ul className="campaign-recipients">
          {recipients.map((recipient) => (
            <li key={recipient.id}>
              <span dir="auto">{recipient.client_name || recipient.email || '—'}</span>
              <span className={`soft-badge ${recipient.status === 'sent' ? 'badge-green' : recipient.status === 'failed' ? 'badge-red' : 'badge-muted'}`}>{t(recipientStatusKey(recipient.status))}</span>
              {recipient.error && <small className="muted-copy" dir="auto">{recipient.error}</small>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export default function CampaignsPage() {
  const { t, locale } = useLocale();
  const { profile } = useAuth();
  const [clients, setClients] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [language, setLanguage] = useState(CAMPAIGN_LANGUAGES.includes(locale) ? locale : 'en');
  const [audience, setAudience] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const bodyRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [clientRows, campaignRows] = await Promise.all([listMyClients(), listCampaigns()]);
      setClients(clientRows.filter((client) => client.status === 'active'));
      setCampaigns(campaignRows);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    getEmailStatus().then(setConfigured).catch(() => setConfigured(true));
  }, [refresh]);

  const coachName = profile?.brand_name || profile?.full_name || 'ApexFit';
  const sampleClient = clients.find((client) => selectedIds.includes(client.client_id)) || clients[0];
  const preview = useMemo(() => renderCampaignEmail({
    subject: subject || '…',
    body: body || '…',
    language,
    clientName: sampleClient?.client_name || 'Sara',
    coachName,
    unsubscribeUrl: 'https://example.com/unsubscribe',
  }), [subject, body, language, sampleClient, coachName]);

  function toggleClient(id) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function insertVariable(name) {
    const field = bodyRef.current;
    const token = `{{${name}}}`;
    const start = field?.selectionStart ?? body.length;
    const end = field?.selectionEnd ?? body.length;
    setBody((current) => `${current.slice(0, start)}${token}${current.slice(end)}`);
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function deliver(campaignId) {
    setSending(true);
    setProgress({ sent: 0, failed: 0, remaining: null });
    setFormError('');
    try {
      const result = await runCampaignSend(sendCampaignBatch, campaignId, { onProgress: setProgress });
      setNotice(result.stopped ? t('campaignStopped') : result.failed ? t('campaignDonePartial') : t('campaignDone'));
    } catch (error) {
      setFormError(`${t('campaignSendError')} ${error.message}`);
    } finally {
      setSending(false);
      setProgress(null);
      await refresh();
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setNotice('');
    setFormError('');
    const draft = validateCampaignDraft({ subject, body, language });
    setErrors(draft.errors);
    if (!draft.valid) return;
    if (audience === 'selected' && selectedIds.length === 0) {
      setFormError(t('campaignErrNoRecipients'));
      return;
    }
    let campaign;
    try {
      campaign = await createCampaign({ subject: draft.subject, body: draft.body, language, clientIds: selectedIds, sendToAll: audience === 'all' });
    } catch (error) {
      setFormError(`${t('campaignCreateError')} ${error.message}`);
      return;
    }
    setSubject('');
    setBody('');
    setSelectedIds([]);
    await deliver(campaign.id);
  }

  async function handleRetry(campaignId) {
    try {
      await retryFailedRecipients(campaignId);
      await deliver(campaignId);
    } catch (error) {
      setFormError(`${t('campaignSendError')} ${error.message}`);
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('campaignsTitle')} description={t('campaignsDescription')} />
      {!configured && <div className="notice notice-error" role="alert">{t('campaignNotConfigured')}</div>}
      {loadError && <div className="notice notice-error" role="alert">{t('campaignLoadError')} {loadError}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !loadError && clients.length === 0 && <section className="panel"><div className="dashboard-empty"><h3>{t('emptyClients')}</h3><p>{t('campaignNeedClients')}</p></div></section>}

      {clients.length > 0 && (
        <div className="client-feature-grid">
          <form className="panel message-composer" onSubmit={handleSubmit} noValidate>
            <div className="panel-heading"><div><span className="eyebrow">{t('navCampaigns')}</span><h3>{t('campaignNew')}</h3></div></div>
            <label className="form-label">{t('campaignSubject')}
              <input className="field" maxLength={CAMPAIGN_SUBJECT_MAX} value={subject} dir="auto" onChange={(event) => setSubject(event.target.value)} aria-invalid={Boolean(errors.subject)} />
              {errors.subject && <small className="field-error" role="alert">{t(errors.subject)}</small>}
            </label>
            <label className="form-label">{t('campaignLanguage')}
              <select className="field" value={language} onChange={(event) => setLanguage(event.target.value)}>
                {CAMPAIGN_LANGUAGES.map((code) => <option key={code} value={code}>{LANGUAGE_NAMES[code]}</option>)}
              </select>
            </label>
            <fieldset className="audience-picker">
              <legend>{t('campaignRecipients')}</legend>
              <label className="checkbox-row"><input type="radio" name="campaign-audience" checked={audience === 'all'} onChange={() => setAudience('all')} />{t('campaignAll')} ({clients.length})</label>
              <label className="checkbox-row"><input type="radio" name="campaign-audience" checked={audience === 'selected'} onChange={() => setAudience('selected')} />{t('campaignSelected')}</label>
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
            <label className="form-label">{t('campaignBody')}
              <textarea ref={bodyRef} className="field intake-textarea campaign-body" maxLength={CAMPAIGN_BODY_MAX} value={body} dir={isRtlLanguage(language) ? 'rtl' : 'ltr'} onChange={(event) => setBody(event.target.value)} aria-invalid={Boolean(errors.body)} />
              {errors.body && <small className="field-error" role="alert">{t(errors.body)}</small>}
            </label>
            <div className="campaign-variables">
              <small className="muted-copy">{t('campaignVariablesHint')}</small>
              <button className="text-action" type="button" onClick={() => insertVariable('client_name')}>{t('campaignInsertClient')}</button>
              <button className="text-action" type="button" onClick={() => insertVariable('coach_name')}>{t('campaignInsertCoach')}</button>
              <small className="muted-copy" dir="ltr">{body.length}/{CAMPAIGN_BODY_MAX}</small>
            </div>
            <div className="campaign-preview">
              <span className="eyebrow">{t('campaignPreview')}</span>
              <p className="muted-copy" dir="auto"><strong>{preview.subject}</strong></p>
              <iframe title={t('campaignPreview')} sandbox="" srcDoc={preview.html} />
              <small className="muted-copy">{t('campaignPreviewHint')}</small>
            </div>
            <p className="muted-copy">{t('campaignComplianceNote')}</p>
            {formError && <div className="notice notice-error" role="alert">{formError}</div>}
            {notice && <div className="notice notice-info" role="status">{notice}</div>}
            {progress && (
              <div className="notice notice-info" role="status">
                {t('campaignSending')} {t('campaignSentLabel')}: {progress.sent} · {t('campaignFailedLabel')}: {progress.failed}{progress.remaining !== null ? ` · ${t('campaignRemaining')}: ${progress.remaining}` : ''}
              </div>
            )}
            <Button variant="primary" type="submit" disabled={sending || !configured}>{sending ? t('campaignSending') : t('campaignSend')}</Button>
          </form>

          <section className="panel message-history">
            <div className="panel-heading"><div><span className="eyebrow">{t('navCampaigns')}</span><h3>{t('campaignHistory')}</h3></div></div>
            {campaigns.length === 0 && <div className="empty-state">{t('campaignNoHistory')}</div>}
            <div className="sent-list">
              {campaigns.map((campaign) => (
                <CampaignHistoryItem key={campaign.id} campaign={campaign} busy={sending || !configured} onResume={deliver} onRetry={handleRetry} locale={locale} t={t} />
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
