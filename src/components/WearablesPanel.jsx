import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from './Button.jsx';
import HealthMetricsView from './HealthMetricsView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { parseAppleHealthFile, parseHealthSummary, readTextFile } from '../services/healthImport.js';
import {
  deleteWearableData, disconnectWearable, getHealthOverview, saveWearableMetrics, startWearableConnection, syncWearable,
} from '../services/healthService.js';
import { HEALTH_PROVIDERS, connectionState, emptyMetricsForm, importErrorKey, validateMetricsForm } from '../services/healthUtils.js';

const RESULT_KEYS = ['connected', 'connected_nodata', 'denied', 'failed'];
const MANUAL_FIELDS = [
  { key: 'steps', labelKey: 'hltSteps', step: '1' },
  { key: 'sleepHours', labelKey: 'hltSleepHours', step: '0.1' },
  { key: 'restingHeartRate', labelKey: 'hltRestingHr', step: '1' },
  { key: 'activeCalories', labelKey: 'hltActiveCalories', step: '1' },
  { key: 'hrv', labelKey: 'hltHrv', step: '0.1' },
  { key: 'recovery', labelKey: 'hltRecovery', step: '1' },
];
const BADGE = { connected: 'badge-green', error: 'badge-red', disconnected: 'badge-muted' };

// Apple Health file import, Fitbit / Garmin / Oura connections, a quick manual entry and the last seven days.
export default function WearablesPanel() {
  const { t, locale } = useLocale();
  const today = getLocalDateString();
  const [params, setParams] = useSearchParams();
  const fileInput = useRef(null);
  const abort = useRef(null);
  const [overview, setOverview] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState(emptyMetricsForm(today));
  const [errors, setErrors] = useState({});

  const load = useCallback(async () => {
    try {
      setOverview(await getHealthOverview(null, 8));
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    }
  }, []);

  useEffect(() => {
    load();
    return () => abort.current?.abort();
  }, [load]);

  // Back from the provider's authorization page.
  useEffect(() => {
    const result = params.get('result');
    const provider = params.get('wearable');
    if (!result || !provider) return;
    if (RESULT_KEYS.includes(result)) setNotice({ kind: result === 'connected' ? 'info' : 'error', text: `${t(`hltProv_${provider}`)}: ${t(`hltResult_${result}`)}` });
    setParams({}, { replace: true });
    load();
  }, [params, setParams, load, t]);

  const report = (kind, text) => setNotice({ kind, text });
  const connections = overview?.connections || [];
  const dateFormat = (value) => new Date(value).toLocaleString(locale);

  async function run(name, task) {
    setBusy(name);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      report('error', error.message);
    } finally {
      setBusy('');
    }
  }

  // Every device can be connected from here. If the platform owner has not added the service's keys yet the server
  // answers 503, and the person is told what is missing instead of seeing a dead end.
  async function connect(provider) {
    setBusy(provider);
    setNotice(null);
    try {
      const { url } = await startWearableConnection(provider);
      window.location.assign(url);
    } catch (error) {
      setBusy('');
      report('error', error.status === 503 ? `${t(`hltProv_${provider}`)}: ${t('hltSetupNeeded')}` : error.message);
    }
  }
  const sync = (provider) => run(provider, async () => {
    const result = await syncWearable(provider);
    await load();
    report('info', result.throttled ? t('hltSyncThrottled') : `${t('hltSynced')} ${result.days}`);
  });
  const disconnect = (provider) => run(provider, async () => {
    await disconnectWearable(provider);
    await load();
    report('info', t('hltDisconnected'));
  });
  const removeApple = () => run('apple_health', async () => {
    await deleteWearableData('apple_health');
    await load();
    report('info', t('hltDataDeleted'));
  });

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    setPreview(null);
    setProgress(0);
    setBusy('read');
    abort.current = new AbortController();
    try {
      let parsed;
      if (/\.(xml|zip)$/i.test(file.name)) {
        parsed = await parseAppleHealthFile(file, { today, onProgress: setProgress, signal: abort.current.signal });
      } else {
        const read = await readTextFile(file);
        parsed = read.ok ? parseHealthSummary(read.text, { today }) : read;
      }
      if (!parsed.ok) report('error', t(importErrorKey(parsed.error)));
      else setPreview({ name: file.name, ...parsed });
    } catch (error) {
      report('error', `${t('hltImpFailed')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  const saveImport = () => run('import', async () => {
    const saved = await saveWearableMetrics('apple_health', preview.days);
    setPreview(null);
    await load();
    report('info', `${t('hltImported')} ${saved}`);
  });

  async function saveManual(event) {
    event.preventDefault();
    const result = validateMetricsForm(form, today);
    setErrors(result.errors);
    if (!result.valid) return;
    await run('manual', async () => {
      await saveWearableMetrics('manual', [result.payload]);
      setForm(emptyMetricsForm(today));
      await load();
      report('info', t('hltManualSaved'));
    });
  }

  function renderActions(provider, state) {
    if (provider === 'apple_health') {
      return (
        <>
          <input ref={fileInput} type="file" accept=".xml,.zip,.csv,.json" className="sr-only" onChange={chooseFile} aria-label={t('hltImportChoose')} />
          <Button variant="secondary" type="button" onClick={() => fileInput.current?.click()} disabled={busy !== ''}>{busy === 'read' ? `${t('hltImpReading')} ${Math.round(progress * 100)}%` : t('hltImportChoose')}</Button>
          {state === 'connected' && <Button variant="secondary" type="button" onClick={removeApple} disabled={busy !== ''}>{t('hltDeleteData')}</Button>}
        </>
      );
    }
    if (state === 'disconnected') return <Button variant="primary" type="button" onClick={() => connect(provider)} disabled={busy !== ''}>{busy === provider ? t('hltConnecting') : t('hltConnect')}</Button>;
    return (
      <>
        {state === 'error'
          ? <Button variant="primary" type="button" onClick={() => connect(provider)} disabled={busy !== ''}>{t('hltReconnect')}</Button>
          : <Button variant="primary" type="button" onClick={() => sync(provider)} disabled={busy !== ''}>{busy === provider ? t('hltSyncing') : t('hltSyncNow')}</Button>}
        <Button variant="secondary" type="button" onClick={() => disconnect(provider)} disabled={busy !== ''}>{t('hltDisconnect')}</Button>
      </>
    );
  }

  return (
    <div className="wearables-panel">
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {loadError && <div className="notice notice-error" role="alert">{t('hltLoadError')} {loadError}</div>}

      <div className="integration-grid">
        {HEALTH_PROVIDERS.map((provider) => {
          const state = connectionState(connections, provider);
          const connection = connections.find((item) => item.provider === provider);
          return (
            <article className="panel integration-card" key={provider}>
              <div className="template-card-heading">
                <h3>{t(`hltProv_${provider}`)}</h3>
                <span className={`soft-badge ${BADGE[state]}`}>{t(`hltState_${state}`)}</span>
              </div>
              <p className="muted-copy">{t(`hltProvDesc_${provider}`)}</p>
              {connection?.last_synced_at && <small className="muted-copy">{t('hltLastSync')}: <time dateTime={connection.last_synced_at}>{dateFormat(connection.last_synced_at)}</time></small>}
              {state === 'error' && connection?.last_error && <small className="field-error" dir="auto">{connection.last_error}</small>}
              <div className="template-actions">{renderActions(provider, state)}</div>
            </article>
          );
        })}
      </div>

      {preview && (
        <section className="panel import-preview">
          <h3 dir="auto">{preview.name}</h3>
          <p>{t('hltImportFound')} <strong>{preview.days.length}</strong> {t('nutImportDays')} · <span dir="ltr">{preview.range.from} → {preview.range.to}</span></p>
          {preview.warnings?.length > 0 && <small className="muted-copy">{t('hltImportWarnings')}: {preview.warnings.length}</small>}
          <div className="template-actions">
            <Button variant="primary" type="button" onClick={saveImport} disabled={busy !== ''}>{busy === 'import' ? t('nutImporting') : t('hltImportSave')}</Button>
            <Button variant="secondary" type="button" onClick={() => setPreview(null)} disabled={busy !== ''}>{t('nutCancel')}</Button>
          </div>
        </section>
      )}

      <div className="client-feature-grid">
        <section className="panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('hltTab')}</span><h3>{t('hltLast7')}</h3></div></div>
          {overview ? <HealthMetricsView metrics={overview.metrics} today={today} /> : <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
          <small className="muted-copy">{t('hltImportHelp')}</small>
        </section>

        <form className="panel" onSubmit={saveManual} noValidate>
          <div className="panel-heading"><div><span className="eyebrow">{t('hltTab')}</span><h3>{t('hltManualTitle')}</h3></div></div>
          <label className="form-label">{t('foodDate')}
            <input className="field" type="date" value={form.date} max={today} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} aria-invalid={Boolean(errors.date)} />
            {errors.date && <small className="field-error">{t(errors.date)}</small>}
          </label>
          <div className="food-macro-grid">
            {MANUAL_FIELDS.map((field) => (
              <label className="form-label" key={field.key}>{t(field.labelKey)}
                <input className="field" type="number" inputMode="decimal" min="0" step={field.step} value={form[field.key]} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))} aria-invalid={Boolean(errors[field.key])} />
                {errors[field.key] && <small className="field-error">{t(errors[field.key])}</small>}
              </label>
            ))}
          </div>
          {errors.form && <div className="notice notice-error" role="alert">{t(errors.form)}</div>}
          <Button variant="primary" type="submit" disabled={busy !== ''}>{busy === 'manual' ? t('nutSaving') : t('hltManualSave')}</Button>
        </form>
      </div>
    </div>
  );
}
