import { useCallback, useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { clearIntegrationKeys, getIntegrationKeys, saveIntegrationKeys } from '../services/platformService.js';

const PROVIDERS = ['fitbit', 'garmin', 'oura', 'google'];

function ProviderCard({ item, canStore, onChange }) {
  const { t } = useLocale();
  const [clientId, setClientId] = useState(item.source === 'database' ? item.clientId : '');
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(false);

  async function run(name, task) {
    setBusy(name);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      if (error.payload?.errors) setErrors(error.payload.errors);
      setNotice({ kind: 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  const save = () => run('save', async () => {
    setErrors({});
    const next = await saveIntegrationKeys({ provider: item.provider, clientId, clientSecret: secret });
    setSecret('');
    onChange(next);
    setNotice({ kind: 'info', text: t('adminIntSaved') });
  });

  const remove = () => run('clear', async () => {
    const next = await clearIntegrationKeys(item.provider);
    setClientId('');
    setSecret('');
    onChange(next);
    setNotice({ kind: 'info', text: t('adminIntRemoved') });
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(item.redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The address stays selectable on screen.
    }
  }

  return (
    <article className="panel admin-int-card">
      <div className="template-card-heading">
        <h3>{t(`adminIntProvider_${item.provider}`)}</h3>
        <span className={`soft-badge ${item.source === 'none' ? 'badge-muted' : 'badge-green'}`}>{t(`adminIntSource_${item.source}`)}</span>
      </div>
      <p className="muted-copy">{t(`adminIntHelp_${item.provider}`)}</p>
      {item.unreadable && <div className="notice notice-error" role="alert">{t('adminIntUnreadable')}</div>}

      {item.redirectUri ? (
        <div className="admin-int-redirect">
          <small className="muted-copy">{t('adminIntRedirect')}</small>
          <div className="store-share-row">
            <input className="field" readOnly value={item.redirectUri} dir="ltr" onFocus={(event) => event.target.select()} aria-label={t('adminIntRedirect')} />
            <Button variant="secondary" size="small" type="button" onClick={copy}>{copied ? t('adminIntCopied') : t('adminIntCopy')}</Button>
          </div>
        </div>
      ) : <div className="notice notice-info" role="status">{t('adminIntNeedsAppUrl')}</div>}

      <label className="form-label">{t('adminIntClientId')}
        <input className="field" value={clientId} autoComplete="off" spellCheck={false} dir="ltr" aria-invalid={Boolean(errors.clientId)} onChange={(event) => { setClientId(event.target.value); setErrors({}); }} />
        {errors.clientId && <small className="field-error">{t(errors.clientId)}</small>}
      </label>
      <label className="form-label">{t('adminIntSecret')}
        <input
          className="field"
          type="password"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          value={secret}
          placeholder={item.source === 'database' ? t('aiSavedPlaceholder') : ''}
          aria-invalid={Boolean(errors.clientSecret)}
          onChange={(event) => { setSecret(event.target.value); setErrors({}); }}
        />
        {errors.clientSecret && <small className="field-error">{t(errors.clientSecret)}</small>}
      </label>

      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      <div className="template-actions">
        <Button variant="primary" type="button" onClick={save} disabled={busy !== '' || !canStore}>{busy === 'save' ? t('aiSaving') : t('adminIntSave')}</Button>
        {item.source === 'database' && <Button variant="secondary" type="button" onClick={remove} disabled={busy !== ''}>{t('adminIntRemove')}</Button>}
      </div>
    </article>
  );
}

// The keys of the connected services, for the platform owner only. A saved key takes precedence over the server's
// environment variables; removing it returns to them.
export default function PlatformIntegrationsPanel() {
  const { t } = useLocale();
  const [view, setView] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    getIntegrationKeys().then(setView).catch((loadError) => setError(loadError.message));
  }, []);
  useEffect(load, [load]);

  if (error) return <div className="notice notice-error" role="alert">{t('aiLoadError')} {error}</div>;
  if (!view) return <div className="empty-state" role="status">{t('loadingProgress')}</div>;

  return (
    <>
      {!view.canStoreCredentials && <div className="notice notice-info" role="status">{t('aiNeedsKey')}</div>}
      <div className="integration-grid admin-int-grid">
        {PROVIDERS.map((provider) => {
          const item = view.providers.find((entry) => entry.provider === provider);
          return item ? <ProviderCard key={`${provider}-${item.updatedAt}-${item.source}`} item={item} canStore={view.canStoreCredentials} onChange={setView} /> : null;
        })}
      </div>
    </>
  );
}
