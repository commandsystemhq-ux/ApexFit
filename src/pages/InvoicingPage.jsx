import { useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { CURRENCIES, clientLabel, formatMoney } from '../services/coachingUtils.js';
import {
  createInvoice,
  createPackage,
  createPackageInvoice,
  getStripeConnectStatus,
  listInvoices,
  listPackages,
  setPackageActive,
  startStripeOnboarding,
  voidInvoice,
} from '../services/invoicingService.js';

const EMPTY_PACKAGE = { name: '', description: '', session_count: '10', price: '', currency: 'usd' };
const EMPTY_INVOICE = { clientId: '', packageId: '', description: '', amount: '', currency: 'usd', dueDate: '' };

export default function InvoicingPage({ onNavigate, onNotify }) {
  const { locale, t } = useLocale();
  const [clients, setClients] = useState([]);
  const [packages, setPackages] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [stripeStatus, setStripeStatus] = useState({ state: 'loading' });
  const [loadError, setLoadError] = useState('');
  const [packageForm, setPackageForm] = useState(EMPTY_PACKAGE);
  const [invoiceForm, setInvoiceForm] = useState(EMPTY_INVOICE);
  const [packageError, setPackageError] = useState('');
  const [invoiceError, setInvoiceError] = useState('');
  const [busy, setBusy] = useState('');

  const clientsById = new Map(clients.map((client) => [client.client_id, client]));
  const activePackages = packages.filter((item) => item.is_active);

  async function refresh() {
    try {
      const [clientRows, packageRows, invoiceRows] = await Promise.all([listMyClients(), listPackages(), listInvoices()]);
      setClients(clientRows.filter((client) => client.status === 'active'));
      setPackages(packageRows);
      setInvoices(invoiceRows);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    }
  }

  useEffect(() => {
    refresh();
    getStripeConnectStatus()
      .then((status) => setStripeStatus({ state: 'ready', ...status }))
      .catch((error) => setStripeStatus({ state: 'error', message: error.message }));
  }, []);

  async function handleConnect() {
    setBusy('stripe');
    try {
      const { url } = await startStripeOnboarding();
      window.location.assign(url);
    } catch (error) {
      onNotify(`${t('stripeConnectError')} ${error.message}`);
      setBusy('');
    }
  }

  async function handleCreatePackage(event) {
    event.preventDefault();
    setPackageError('');
    setBusy('package');
    try {
      await createPackage(packageForm);
      setPackageForm(EMPTY_PACKAGE);
      await refresh();
    } catch (error) {
      setPackageError(`${t('packageSaveError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function togglePackage(item) {
    try {
      await setPackageActive(item.id, !item.is_active);
      await refresh();
    } catch (error) {
      onNotify(error.message);
    }
  }

  async function handleCreateInvoice(event) {
    event.preventDefault();
    setInvoiceError('');
    setBusy('invoice');
    try {
      if (!invoiceForm.clientId) throw new TypeError(t('chooseClientFirst'));
      if (invoiceForm.packageId) {
        await createPackageInvoice(invoiceForm.clientId, invoiceForm.packageId, { notify: true });
      } else {
        await createInvoice(invoiceForm);
      }
      setInvoiceForm(EMPTY_INVOICE);
      onNotify(t('invoiceCreated'));
      await refresh();
    } catch (error) {
      setInvoiceError(`${t('invoiceCreateError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function handleVoid(invoiceId) {
    try {
      await voidInvoice(invoiceId);
      await refresh();
    } catch (error) {
      onNotify(error.message);
    }
  }

  const stripeReady = stripeStatus.state === 'ready' && stripeStatus.charges_enabled;
  const updateInvoice = (field, value) => setInvoiceForm((current) => ({ ...current, [field]: value }));
  const updatePackage = (field, value) => setPackageForm((current) => ({ ...current, [field]: value }));

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('invoicing')} description={t('invoicingDescription')} />
      {loadError && <div className="notice notice-error" role="alert">{t('invoicingLoadError')} {loadError}</div>}

      <section className="panel stripe-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">Stripe</span><h3>{t('paymentsSetup')}</h3></div>
          <span className={`soft-badge ${stripeReady ? 'badge-blue' : 'badge-muted'}`}>
            {stripeStatus.state === 'loading' ? t('loadingProgress') : t(stripeReady ? 'paymentsReady' : 'paymentsNotReady')}
          </span>
        </div>
        <p className="muted-copy">{t('paymentsHelp')}</p>
        {stripeStatus.state === 'error' && <div className="notice notice-info" role="status">{t('stripeUnavailable')} {stripeStatus.message}</div>}
        {stripeStatus.state === 'ready' && !stripeReady && (
          <Button variant="primary" onClick={handleConnect} disabled={busy === 'stripe'}>
            {stripeStatus.connected ? t('stripeContinueOnboarding') : t('stripeConnect')}
          </Button>
        )}
      </section>

      <div className="client-feature-grid">
        <section className="panel package-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('packages')}</span><h3>{t('trainingPackages')}</h3></div></div>
          <form className="package-form" onSubmit={handleCreatePackage}>
            <label className="form-label">{t('packageName')}<input className="field" maxLength={120} value={packageForm.name} onChange={(event) => updatePackage('name', event.target.value)} placeholder={t('packageNamePlaceholder')} required /></label>
            <div className="form-grid">
              <label className="form-label">{t('packageSessions')}<input className="field" type="number" min="1" max="500" value={packageForm.session_count} onChange={(event) => updatePackage('session_count', event.target.value)} required /></label>
              <label className="form-label">{t('packagePrice')}<input className="field" inputMode="decimal" value={packageForm.price} onChange={(event) => updatePackage('price', event.target.value)} placeholder="450.00" required /></label>
            </div>
            <label className="form-label">{t('currency')}
              <select className="field" value={packageForm.currency} onChange={(event) => updatePackage('currency', event.target.value)}>
                {CURRENCIES.map((code) => <option key={code} value={code}>{code.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="form-label">{t('packageDescription')}<input className="field" maxLength={500} value={packageForm.description} onChange={(event) => updatePackage('description', event.target.value)} /></label>
            {packageError && <div className="notice notice-error" role="alert">{packageError}</div>}
            <Button variant="primary" type="submit" disabled={busy === 'package'}>{t('createPackage')}</Button>
          </form>
          {packages.length === 0 && <div className="empty-state">{t('noPackages')}</div>}
          <div className="package-list">
            {packages.map((item) => (
              <article className="package-card" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.session_count} {t('sessionsWord')} · {formatMoney(item.price_cents, item.currency, locale)}</small>
                </div>
                <button className="text-action" type="button" onClick={() => togglePackage(item)}>{item.is_active ? t('deactivatePackage') : t('activatePackage')}</button>
              </article>
            ))}
          </div>
        </section>

        <section className="panel invoice-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('invoicesWord')}</span><h3>{t('issueInvoice')}</h3></div></div>
          {clients.length === 0
            ? <div className="dashboard-empty"><p>{t('messagesNeedClients')}</p><Button variant="secondary" onClick={() => onNavigate('clients')}>{t('inviteClient')}</Button></div>
            : (
              <form className="package-form" onSubmit={handleCreateInvoice}>
                <label className="form-label">{t('clientWord')}
                  <select className="field" value={invoiceForm.clientId} onChange={(event) => updateInvoice('clientId', event.target.value)} required>
                    <option value="">{t('chooseClient')}</option>
                    {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
                  </select>
                </label>
                <label className="form-label">{t('sellPackage')}
                  <select className="field" value={invoiceForm.packageId} onChange={(event) => updateInvoice('packageId', event.target.value)}>
                    <option value="">{t('customInvoice')}</option>
                    {activePackages.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatMoney(item.price_cents, item.currency, locale)}</option>)}
                  </select>
                </label>
                {!invoiceForm.packageId && (
                  <>
                    <label className="form-label">{t('invoiceDescription')}<input className="field" maxLength={300} value={invoiceForm.description} onChange={(event) => updateInvoice('description', event.target.value)} required /></label>
                    <div className="form-grid">
                      <label className="form-label">{t('invoiceAmount')}<input className="field" inputMode="decimal" value={invoiceForm.amount} onChange={(event) => updateInvoice('amount', event.target.value)} required /></label>
                      <label className="form-label">{t('currency')}
                        <select className="field" value={invoiceForm.currency} onChange={(event) => updateInvoice('currency', event.target.value)}>
                          {CURRENCIES.map((code) => <option key={code} value={code}>{code.toUpperCase()}</option>)}
                        </select>
                      </label>
                    </div>
                    <label className="form-label">{t('dueDate')}<input className="field" type="date" value={invoiceForm.dueDate} onChange={(event) => updateInvoice('dueDate', event.target.value)} /></label>
                  </>
                )}
                {invoiceError && <div className="notice notice-error" role="alert">{invoiceError}</div>}
                <Button variant="primary" type="submit" disabled={busy === 'invoice'}>{t('sendInvoice')}</Button>
              </form>
            )}
        </section>
      </div>

      <section className="panel invoice-list-panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('invoicesWord')}</span><h3>{t('allInvoices')}</h3></div></div>
        {invoices.length === 0 && <div className="empty-state">{t('noInvoices')}</div>}
        <div className="invoice-list">
          {invoices.map((invoice) => (
            <article className="invoice-row" key={invoice.id}>
              <div className="invoice-row-main">
                <strong>{invoice.invoice_number}</strong>
                <span>{invoice.description}</span>
                <small>{clientLabel(clientsById.get(invoice.client_id))} · {new Date(invoice.created_at).toLocaleDateString(locale)}</small>
              </div>
              <strong>{formatMoney(invoice.amount_cents, invoice.currency, locale)}</strong>
              <span className={`soft-badge invoice-${invoice.status}`}>{t(`invoice_${invoice.status}`)}</span>
              {invoice.status === 'open' && <button className="text-action" type="button" onClick={() => handleVoid(invoice.id)}>{t('voidInvoice')}</button>}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
