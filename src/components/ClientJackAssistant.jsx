import { useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { analyzeClient, draftProgressReport } from '../services/aiService.js';
import { saveProgressReport, shareProgressReport } from '../services/accountabilityService.js';
import { announceChatChanged, sendChatMessage } from '../services/chatService.js';
import { notifyChatReceiver } from '../services/pushService.js';

const PERIODS = [7, 14, 30, 60, 90];
const MESSAGE_LIMIT = 2000;
const REPORT_LIMIT = 3000;

// Jack for one client: an analysis of the real numbers with changes to suggest, and a progress report draft (Arabic or
// English) that the coach reviews and edits, then saves, shares with the client, or sends in the chat.
export default function ClientJackAssistant({ clientId, clientName = '' }) {
  const { t, locale } = useLocale();
  const [days, setDays] = useState(30);
  const [language, setLanguage] = useState(locale === 'en' ? 'en' : 'ar');
  const [analysis, setAnalysis] = useState({ status: 'idle', data: null, error: '' });
  const [report, setReport] = useState({ status: 'idle', text: '', source: '', error: '' });
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');

  async function runAnalysis() {
    setAnalysis({ status: 'loading', data: null, error: '' });
    try {
      setAnalysis({ status: 'ready', data: await analyzeClient({ clientId, days: Math.max(14, days), language: locale === 'ar' ? 'ar' : 'en' }), error: '' });
    } catch (error) {
      setAnalysis({ status: 'error', data: null, error: error.message });
    }
  }

  async function runReport() {
    setReport({ status: 'loading', text: '', source: '', error: '' });
    setNotice(null);
    try {
      const draft = await draftProgressReport({ clientId, days, language });
      setReport({ status: 'ready', text: draft.text, source: draft.source, error: '' });
    } catch (error) {
      setReport({ status: 'error', text: '', source: '', error: error.message });
    }
  }

  async function act(kind, action) {
    setBusy(kind);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('jaActionError')} ${error.message}` });
    } finally {
      setBusy('');
    }
  }

  const text = report.text.trim();
  const saveReport = () => act('save', async () => {
    await saveProgressReport(clientId, days, text);
    setNotice({ kind: 'info', text: t('jaReportSaved') });
  });
  const shareReport = () => act('share', async () => {
    const saved = await saveProgressReport(clientId, days, text);
    await shareProgressReport(saved.id, true);
    setNotice({ kind: 'info', text: t('jaReportShared') });
  });
  const sendInChat = () => act('send', async () => {
    const message = await sendChatMessage(clientId, text, crypto.randomUUID());
    announceChatChanged();
    if (message?.id) await notifyChatReceiver(message.id);
    setNotice({ kind: 'info', text: t('jaReportSent') });
  });
  const copy = () => act('copy', async () => {
    await navigator.clipboard.writeText(text);
    setNotice({ kind: 'info', text: t('rptCopied') });
  });

  const tooLongForChat = text.length > MESSAGE_LIMIT;
  const sourceBadge = (source) => <span className={`soft-badge ${source === 'ai' ? 'badge-blue' : 'badge-muted'}`}>{t(source === 'ai' ? 'jaSourceAi' : 'jaSourceRules')}</span>;

  return (
    <div className="jack-assistant-panel">
      <div className="jack-assistant-controls">
        <label className="form-label">{t('rptPeriod')}
          <select className="field" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {PERIODS.map((period) => <option key={period} value={period}>{t('rptPeriodDays').replace('{n}', period)}</option>)}
          </select>
        </label>
        <label className="form-label">{t('jaReportLanguage')}
          <select className="field" value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <p className="muted-copy">{t('jaPrivacy')}</p>

      <section className="jack-assistant-section">
        <div className="jack-assistant-heading"><h4>{t('jaAnalysisTitle')}</h4><Button variant="secondary" size="small" type="button" onClick={runAnalysis} disabled={analysis.status === 'loading'}>{analysis.status === 'loading' ? t('rptWorking') : t('jaAnalyze')}</Button></div>
        {analysis.status === 'error' && <div className="notice notice-error" role="alert">{t('jaAnalysisError')} {analysis.error}</div>}
        {analysis.status === 'ready' && (
          <div className="jack-analysis">
            <p>{sourceBadge(analysis.data.source)} <small>{analysis.data.summary}</small></p>
            <ul className="jack-findings">
              {analysis.data.findings.map((finding) => <li key={finding.key} className={`finding finding-${finding.severity}`} dir="auto">{finding.text}</li>)}
            </ul>
            {analysis.data.findings.length === 0 && <p className="muted-copy">{t('jaNoFindings')}</p>}
            {analysis.data.recommendations.length > 0 && (
              <>
                <strong>{t('jaRecommendations')}</strong>
                <ul className="jack-recommendations">{analysis.data.recommendations.map((item) => <li key={item} dir="auto">{item}</li>)}</ul>
              </>
            )}
            {analysis.data.narrative && <p className="jack-narrative" dir="auto">{analysis.data.narrative}</p>}
          </div>
        )}
      </section>

      <section className="jack-assistant-section">
        <div className="jack-assistant-heading"><h4>{t('jaReportTitle')}</h4><Button variant="primary" size="small" type="button" onClick={runReport} disabled={report.status === 'loading'}>{report.status === 'loading' ? t('rptWorking') : t('jaCreateReport')}</Button></div>
        {report.status === 'error' && <div className="notice notice-error" role="alert">{t('jaReportError')} {report.error}</div>}
        {report.status === 'ready' && (
          <div className="jack-report-draft">
            <p>{sourceBadge(report.source)} <small>{t('jaReviewFirst')}</small></p>
            <textarea className="field" rows={14} maxLength={REPORT_LIMIT} value={report.text} onChange={(event) => setReport((current) => ({ ...current, text: event.target.value }))} aria-label={t('jaReportTitle')} dir="auto" />
            <small className={tooLongForChat ? 'field-error' : 'muted-copy'}>{text.length} / {MESSAGE_LIMIT}{tooLongForChat ? ` · ${t('jaTooLongForChat')}` : ''}</small>
            <div className="jack-report-actions">
              <Button variant="primary" size="small" type="button" disabled={Boolean(busy) || text.length < 20 || tooLongForChat} onClick={sendInChat}>{busy === 'send' ? t('rptWorking') : `${t('jaSendInChat')}${clientName ? ` · ${clientName}` : ''}`}</Button>
              <Button variant="secondary" size="small" type="button" disabled={Boolean(busy) || text.length < 20} onClick={shareReport}>{t('rptShareWithClient')}</Button>
              <Button variant="secondary" size="small" type="button" disabled={Boolean(busy) || text.length < 20} onClick={saveReport}>{t('jaSaveReport')}</Button>
              <button className="text-action" type="button" disabled={Boolean(busy)} onClick={copy}>{t('rptCopy')}</button>
            </div>
          </div>
        )}
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      </section>
    </div>
  );
}