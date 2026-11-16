import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import { refreshOnboardingNotices } from '../components/OnboardingNotice.jsx';
import PageHeader from '../components/PageHeader.jsx';
import SignaturePad from '../components/SignaturePad.jsx';
import SignedContractView from '../components/SignedContractView.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { getSignature, listMyContracts, signContract } from '../services/contractService.js';
import { validateSignatureInput } from '../services/contractUtils.js';
import { displayNameFor } from '../services/profileUtils.js';

function SignForm({ contract, defaultName, onSigned }) {
  const { t } = useLocale();
  const showToast = useToast();
  const padRef = useRef(null);
  const [name, setName] = useState(defaultName);
  const [hasInk, setHasInk] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = attempted ? validateSignatureInput({ name, hasInk, agreed }).errors : {};

  async function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    const result = validateSignatureInput({ name, hasInk, agreed });
    if (!result.valid) return;

    setSaving(true);
    try {
      await signContract({ contractId: contract.id, name: result.name, signatureDataUrl: padRef.current.toDataUrl() });
      showToast(t('ctrSignedToast'));
      refreshOnboardingNotices();
      await onSigned();
    } catch (error) {
      showToast(`${t('ctrSignError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;

  return (
    <form className="sign-form" onSubmit={handleSubmit} noValidate>
      <label className="form-label">
        <span>{t('ctrYourName')}</span>
        <input className="field" value={name} maxLength={120} autoComplete="name" placeholder={t('ctrNamePlaceholder')} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(errors.name)} />
        {fieldError(errors.name)}
      </label>
      <div className="form-label">
        <span>{t('ctrDrawSignature')}</span>
        <SignaturePad ref={padRef} onChange={setHasInk} disabled={saving} />
        {fieldError(errors.signature)}
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>{t('ctrAgree')}</span>
      </label>
      {fieldError(errors.agree)}
      <div className="wf-actions">
        <Button type="submit" variant="primary" disabled={saving}>{saving ? t('ctrSigning') : t('ctrSign')}</Button>
      </div>
    </form>
  );
}

export default function ClientContractsPage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const { user, profile } = useAuth();
  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [viewing, setViewing] = useState(null);

  const refresh = useCallback(async () => {
    setContracts(await listMyContracts());
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  async function handleSigned() {
    setOpenId('');
    await refresh();
  }

  async function view(contractId) {
    try {
      setViewing(await getSignature(contractId, user.id));
    } catch (viewError) {
      showToast(`${t('ctrViewError')} ${viewError.message}`);
    }
  }

  const pending = contracts.filter((contract) => (contract.signatures || []).length === 0 && !contract.is_archived);
  const signed = contracts.filter((contract) => (contract.signatures || []).length > 0);
  const defaultName = profile?.full_name || displayNameFor(null, user);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('ctrMyTitle')} description={t('ctrMyDescription')} />
      {error && <div className="notice notice-error" role="alert">{t('ctrLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && contracts.length === 0 && (
        <section className="panel"><div className="dashboard-empty"><h3>{t('ctrMyEmpty')}</h3><p>{t('ctrMyEmptyHelp')}</p></div></section>
      )}

      {pending.length > 0 && (
        <section className="contract-section">
          <h3 className="contract-section-title">{t('ctrToSign')}</h3>
          <div className="contract-list">
            {pending.map((contract) => {
              const open = openId === contract.id;
              return (
                <article className="panel contract-card" key={contract.id}>
                  <div className="template-card-heading">
                    <h3>{contract.title}</h3>
                    {contract.is_required_on_onboarding && <span className="soft-badge badge-amber">{t('ctrRequiredBadge')}</span>}
                  </div>
                  {open ? (
                    <>
                      <div className="contract-text" dir="auto">{contract.content_text}</div>
                      <SignForm contract={contract} defaultName={defaultName} onSigned={handleSigned} />
                    </>
                  ) : (
                    <>
                      <p className="contract-excerpt" dir="auto">{contract.content_text}</p>
                      <div className="template-actions"><Button variant="primary" size="small" onClick={() => setOpenId(contract.id)}>{t('ctrReadAndSign')}</Button></div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {signed.length > 0 && (
        <section className="contract-section">
          <h3 className="contract-section-title">{t('ctrSignedList')}</h3>
          <div className="contract-list">
            {signed.map((contract) => (
              <article className="panel contract-card" key={contract.id}>
                <div className="template-card-heading">
                  <h3>{contract.title}</h3>
                  <span className="soft-badge badge-green">{t('ctrSignedBadge')}</span>
                </div>
                <div className="template-meta"><time dateTime={contract.signatures[0].signed_at}>{t('ctrSignedOn')} {new Date(contract.signatures[0].signed_at).toLocaleDateString(locale)}</time></div>
                <div className="template-actions"><button className="text-action" type="button" onClick={() => view(contract.id)}>{t('ctrViewSigned')}</button></div>
              </article>
            ))}
          </div>
        </section>
      )}

      {viewing && <SignedContractView signature={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
