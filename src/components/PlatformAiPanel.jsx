import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { clearAiSettings, getAiSettings, saveAiSettings, testAiSettings } from '../services/aiSettingsService.js';
import { AI_PROVIDERS, FIELD_EXAMPLES, PROVIDER_FIELDS, validateAiSettings } from '../services/aiProviders.js';

const DEFAULT_CHOICE = 'default';

const labelKey = (provider, name) => (name === 'model' && provider === 'bedrock' ? 'aiField_modelBedrock'
  : name === 'model' && provider === 'azure_foundry' ? 'aiField_modelAzure' : `aiField_${name}`);

// The platform-wide AI provider. Rendered only on the platform owner's admin page; the server refuses anyone else.
export default function PlatformAiPanel() {
  const { t } = useLocale();
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState(DEFAULT_CHOICE);
  const [values, setValues] = useState({});
  const [removed, setRemoved] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const apply = useCallback((next) => {
    setView(next);
    setChoice(next.configured ? next.provider : DEFAULT_CHOICE);
    setValues(next.configured ? { model: next.model, region: next.region, endpoint: next.endpoint } : {});
    setRemoved([]);
    setErrors({});
  }, []);

  useEffect(() => {
    let active = true;
    getAiSettings()
      .then((next) => { if (active) apply(next); })
      .catch((error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [apply]);

  const fields = choice === DEFAULT_CHOICE ? [] : PROVIDER_FIELDS[choice];
  const savedSecrets = useMemo(() => (view?.configured && view.provider === choice ? Object.keys(view.secrets) : []), [view, choice]);

  function pick(provider) {
    setChoice(provider);
    setErrors({});
    setNotice(null);
    setTestResult(null);
    setRemoved([]);
    setValues(view?.configured && view.provider === provider ? { model: view.model, region: view.region, endpoint: view.endpoint } : {});
  }

  const change = (name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };

  function check() {
    const result = validateAiSettings(choice, values, { savedSecrets: savedSecrets.filter((name) => !removed.includes(name)) });
    setErrors(result.errors);
    return result.valid;
  }

  async function run(name, task) {
    setBusy(name);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      if (error.payload?.errors && Object.keys(error.payload.errors).length) setErrors(error.payload.errors);
      setNotice({ kind: 'error', text: `${t('aiSaveError')} ${error.message}` });
    } finally {
      setBusy('');
    }
  }

  const save = () => run('save', async () => {
    if (choice === DEFAULT_CHOICE) {
      apply(await clearAiSettings());
      setTestResult(null);
      setNotice({ kind: 'info', text: t('aiClearedOk') });
      return;
    }
    if (!check()) return;
    apply(await saveAiSettings({ provider: choice, settings: values, removeSecrets: removed }));
    setTestResult(null);
    setNotice({ kind: 'info', text: t('aiSavedOk') });
  });

  const test = () => run('test', async () => {
    setTestResult(null);
    if (choice !== DEFAULT_CHOICE && !check()) return;
    const outcome = await testAiSettings(choice === DEFAULT_CHOICE ? {} : { provider: choice, settings: values, removeSecrets: removed });
    setTestResult(outcome);
    if (outcome.source === 'saved') getAiSettings().then(setView).catch(() => {});
  });

  if (loadError) return <section className="panel settings-panel"><div className="notice notice-error" role="alert">{t('aiLoadError')} {loadError}</div></section>;
  if (!view) return <section className="panel settings-panel"><div className="empty-state" role="status">{t('loadingProgress')}</div></section>;

  const environmentProvider = view.environment.effective;
  const source = view.configured ? 'database' : environmentProvider ? 'environment' : 'none';

  return (
    <section className="panel settings-panel ai-settings" aria-labelledby="ai-settings-title">
      <div className="panel-heading"><div><span className="eyebrow">{t('aiEyebrow')}</span><h3 id="ai-settings-title">{t('aiTitle')}</h3></div></div>
      <p className="muted-copy">{t('aiDescription')}</p>
      <p className="muted-copy ai-source" role="status">
        {t('aiCurrently')}: <strong>{source === 'database' ? `${t('aiSourceDatabase')} · ${t(`aiProvider_${view.provider}`)}` : source === 'environment' ? `${t('aiSourceEnvironment')} · ${t(`aiProvider_${environmentProvider}`)}` : t('aiSourceNone')}</strong>
      </p>
      {!view.environment.canStoreCredentials && <div className="notice notice-info" role="status">{t('aiNeedsKey')}</div>}
      {view.unreadable && <div className="notice notice-error" role="alert">{t('aiUnreadable')}</div>}

      <label className="form-label">{t('aiProviderLabel')}
        <select className="field" value={choice} onChange={(event) => pick(event.target.value)}>
          <option value={DEFAULT_CHOICE}>{t('aiProvider_default')}</option>
          {AI_PROVIDERS.map((provider) => <option key={provider} value={provider}>{t(`aiProvider_${provider}`)}</option>)}
        </select>
      </label>

      {fields.length > 0 && (
        <div className="ai-fields">
          {fields.map((field) => {
            const isSaved = field.secret && savedSecrets.includes(field.name) && !removed.includes(field.name);
            const example = FIELD_EXAMPLES[choice]?.[field.name];
            return (
              <label className="form-label" key={`${choice}-${field.name}`}>
                {t(labelKey(choice, field.name))}{!field.required && <small className="muted-copy"> ({t('aiOptional')})</small>}
                <input
                  className="field"
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  value={values[field.name] || ''}
                  placeholder={isSaved ? t('aiSavedPlaceholder') : example || ''}
                  aria-invalid={Boolean(errors[field.name])}
                  onChange={(event) => change(field.name, event.target.value)}
                />
                {isSaved && !field.required && (
                  <button className="text-action" type="button" onClick={() => setRemoved((current) => [...current, field.name])}>{t('aiRemoveSecret')}</button>
                )}
                {errors[field.name] && <small className="field-error">{t(errors[field.name])}</small>}
              </label>
            );
          })}
          <small className="muted-copy">{t(`aiHint_${choice}`)}</small>
        </div>
      )}

      {choice === DEFAULT_CHOICE && <p className="muted-copy">{t('aiDefaultInfo')}</p>}

      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {testResult && (
        <div className={`notice ${testResult.ok ? 'notice-info' : 'notice-error'}`} role={testResult.ok ? 'status' : 'alert'}>
          {testResult.ok ? (
            <>
              <strong>{t('aiTestOk')}</strong> <span dir="ltr">({testResult.latencyMs} ms)</span>
              <br />{testResult.toolsOk ? t('aiTestToolsOk') : `${t('aiTestToolsNo')} ${testResult.toolsNote || ''}`}
            </>
          ) : (
            <>
              <strong>{t('aiTestFail')}</strong> {testResult.error}
              {testResult.detail && <><br /><span dir="ltr">{testResult.detail}</span></>}
            </>
          )}
        </div>
      )}
      {view.lastTest && !testResult && (
        <p className="muted-copy">{t('aiLastTest')}: {view.lastTest.ok ? t('aiTestOk') : t('aiTestFail')} · {new Date(view.lastTest.at).toLocaleString()}</p>
      )}

      <div className="template-actions">
        <Button variant="primary" type="button" onClick={save} disabled={busy !== '' || (choice === DEFAULT_CHOICE && !view.configured)}>
          {busy === 'save' ? t('aiSaving') : choice === DEFAULT_CHOICE ? t('aiUseDefault') : t('aiSave')}
        </Button>
        <Button variant="secondary" type="button" onClick={test} disabled={busy !== '' || (choice === DEFAULT_CHOICE && source === 'none')}>
          {busy === 'test' ? t('aiTesting') : t('aiTest')}
        </Button>
      </div>
      <small className="muted-copy">{t('aiEveryoneNote')}</small>
    </section>
  );
}
