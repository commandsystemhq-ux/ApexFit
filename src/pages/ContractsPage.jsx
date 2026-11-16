import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import SignedContractView from '../components/SignedContractView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { deleteContract, getSignature, listContracts, saveContract, setContractArchived } from '../services/contractService.js';
import { CONTRACT_LIMITS, CONTRACT_PRESETS, countSignatures, emptyContractDraft, validateContractForm } from '../services/contractUtils.js';

function ContractForm({ initial, saving, onSave, onCancel }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateContractForm(draft).errors : {};

  function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    const result = validateContractForm(draft);
    if (result.valid) onSave({ id: draft.id, ...result.payload });
  }

  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;

  return (
    <form className="panel contract-form" onSubmit={handleSubmit} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('navContracts')}</span><h3>{draft.id ? t('ctrEditTitle') : t('ctrNewTitle')}</h3></div></div>

      {!draft.id && (
        <div className="contract-presets">
          <span className="muted-copy">{t('ctrPresets')}</span>
          {CONTRACT_PRESETS.map((preset) => (
            <button
              className="wf-chip"
              type="button"
              key={preset.id}
              onClick={() => setDraft((current) => ({ ...current, title: t(preset.titleKey), content: t(preset.contentKey), required: preset.required }))}
            >
              {t(preset.titleKey)}
            </button>
          ))}
        </div>
      )}

      {draft.locked && <div className="notice notice-info">{t('ctrLocked')}</div>}

      <label className="form-label">
        <span>{t('ctrFieldTitle')}</span>
        <input className="field" value={draft.title} maxLength={CONTRACT_LIMITS.title + 20} placeholder={t('ctrFieldTitlePlaceholder')} disabled={draft.locked} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} aria-invalid={Boolean(errors.title)} />
        {fieldError(errors.title)}
      </label>
      <label className="form-label">
        <span>{t('ctrFieldContent')}</span>
        <textarea className="field contract-textarea" rows={10} value={draft.content} placeholder={t('ctrFieldContentPlaceholder')} disabled={draft.locked} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} aria-invalid={Boolean(errors.content)} />
        {fieldError(errors.content)}
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={draft.required} onChange={(event) => setDraft((current) => ({ ...current, required: event.target.checked }))} />
        <span>{t('ctrFieldRequired')}</span>
      </label>
      <small className="muted-copy">{t('ctrLegalNote')}</small>
      <div className="wf-actions">
        <Button type="submit" variant="primary" disabled={saving}>{saving ? t('ctrSaving') : t('ctrSave')}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t('ctrCancel')}</Button>
      </div>
    </form>
  );
}

export default function ContractsPage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const [contracts, setContracts] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [openId, setOpenId] = useState('');
  const [viewing, setViewing] = useState(null);

  const refresh = useCallback(async () => {
    const [contractRows, clientRows] = await Promise.all([listContracts(), listMyClients()]);
    setContracts(contractRows);
    setClients(clientRows.filter((client) => client.status === 'active'));
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  const activeIds = useMemo(() => clients.map((client) => client.client_id), [clients]);

  async function handleSave(payload) {
    setSaving(true);
    try {
      await saveContract(payload);
      await refresh();
      setDraft(null);
      showToast(t('ctrSaved'));
    } catch (saveError) {
      showToast(`${t('ctrSaveError')} ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function runAction(contract, action, successKey) {
    setBusyId(contract.id);
    try {
      await action();
      await refresh();
      showToast(t(successKey));
    } catch (actionError) {
      showToast(`${t('ctrActionError')} ${actionError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function view(contractId, clientId) {
    try {
      setViewing(await getSignature(contractId, clientId));
    } catch (viewError) {
      showToast(`${t('ctrViewError')} ${viewError.message}`);
    }
  }

  const headerAction = !draft && <Button variant="primary" onClick={() => setDraft(emptyContractDraft())}>+ {t('ctrNew')}</Button>;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('ctrTitle')} description={t('ctrDescription')} action={headerAction} />

      {draft && <ContractForm key={draft.id || 'new'} initial={draft} saving={saving} onSave={handleSave} onCancel={() => setDraft(null)} />}

      {!draft && (
        <>
          {error && <div className="notice notice-error" role="alert">{t('ctrLoadError')} {error}</div>}
          {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {!loading && !error && contracts.length === 0 && (
            <section className="panel">
              <div className="dashboard-empty">
                <h3>{t('ctrEmpty')}</h3>
                <p>{t('ctrEmptyHelp')}</p>
                <Button variant="primary" onClick={() => setDraft(emptyContractDraft())}>+ {t('ctrNew')}</Button>
              </div>
            </section>
          )}

          <div className="contract-list">
            {contracts.map((contract) => {
              const { signed, total } = countSignatures(contract, activeIds);
              const hasSignatures = (contract.signatures || []).length > 0;
              const open = openId === contract.id;
              const signedBy = new Map((contract.signatures || []).map((signature) => [signature.client_id, signature]));
              return (
                <article className={`panel contract-card ${contract.is_archived ? 'is-archived' : ''}`} key={contract.id}>
                  <div className="template-card-heading">
                    <h3>{contract.title}</h3>
                    <div className="contract-badges">
                      {contract.is_required_on_onboarding && <span className="soft-badge badge-amber">{t('ctrRequiredBadge')}</span>}
                      {contract.is_archived && <span className="soft-badge badge-muted">{t('ctrArchivedBadge')}</span>}
                    </div>
                  </div>
                  <p className="contract-excerpt" dir="auto">{contract.content_text}</p>
                  <div className="template-meta">
                    <span className="soft-badge badge-green">{signed} {t('ctrOf')} {total} {t('ctrSignedCount')}</span>
                    <time dateTime={contract.created_at}>{new Date(contract.created_at).toLocaleDateString(locale)}</time>
                  </div>
                  <div className="template-actions">
                    <button className="text-action" type="button" onClick={() => setOpenId(open ? '' : contract.id)} aria-expanded={open}>{open ? t('ctrHideSignatures') : t('ctrSignatures')}</button>
                    <button className="text-action" type="button" onClick={() => setDraft(emptyContractDraft({ id: contract.id, title: contract.title, content: contract.content_text, required: contract.is_required_on_onboarding, locked: hasSignatures }))}>{t('ctrEdit')}</button>
                    <button className="text-action" type="button" disabled={busyId === contract.id} onClick={() => runAction(contract, () => setContractArchived(contract.id, !contract.is_archived), contract.is_archived ? 'ctrRestoredToast' : 'ctrArchivedToast')}>{contract.is_archived ? t('ctrRestore') : t('ctrArchive')}</button>
                    {!hasSignatures && (
                      <button className="text-action wf-danger" type="button" disabled={busyId === contract.id} onClick={() => window.confirm(t('ctrDeleteConfirm')) && runAction(contract, () => deleteContract(contract.id), 'ctrDeleted')}>{t('ctrDelete')}</button>
                    )}
                  </div>

                  {open && (
                    <ul className="compliance-contracts">
                      {clients.length === 0 && <li className="muted-copy">{t('ctrNoActiveClients')}</li>}
                      {clients.map((client) => {
                        const signature = signedBy.get(client.client_id);
                        return (
                          <li key={client.client_id}>
                            <span>{clientLabel(client)}</span>
                            {signature ? (
                              <>
                                <span className="soft-badge badge-green">{t('ctrStatusSigned')}</span>
                                <small>{new Date(signature.signed_at).toLocaleDateString(locale)}</small>
                                <button className="text-action" type="button" onClick={() => view(contract.id, client.client_id)}>{t('ctrViewSigned')}</button>
                              </>
                            ) : <span className="soft-badge badge-muted">{t('ctrStatusPending')}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>

          {viewing && <SignedContractView signature={viewing} onClose={() => setViewing(null)} />}
        </>
      )}
    </>
  );
}
