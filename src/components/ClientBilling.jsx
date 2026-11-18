import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import PaymentInstructions from './PaymentInstructions.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { formatMoney } from '../services/coachingUtils.js';
import { invoiceStage } from '../services/paymentMethodsUtils.js';
import {
  createPackageInvoice,
  listInvoices,
  listPackages,
  reportInvoicePayment,
} from '../services/invoicingService.js';

export default function ClientBilling({ clientId }) {
  const { locale, t } = useLocale();
  const [packages, setPackages] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [openInvoice, setOpenInvoice] = useState('');

  async function refresh() {
    try {
      const [packageRows, invoiceRows] = await Promise.all([listPackages(), listInvoices()]);
      setPackages(packageRows);
      setInvoices(invoiceRows);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function reportPaid(invoiceId) {
    setBusy(invoiceId);
    setError('');
    try {
      await reportInvoicePayment(invoiceId);
      setNotice(t('payReported'));
      await refresh();
    } catch (reportError) {
      setError(`${t('payReportError')} ${reportError.message}`);
    } finally {
      setBusy('');
    }
  }

  async function buy(packageItem) {
    setBusy(packageItem.id);
    setError('');
    try {
      const invoiceId = await createPackageInvoice(clientId, packageItem.id);
      setNotice(t('payInvoiceCreated'));
      setOpenInvoice(invoiceId);
      await refresh();
    } catch (buyError) {
      setError(`${t('payBuyError')} ${buyError.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="client-progress-layout">
      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('billingTab')}</span><h3>{t('availablePackages')}</h3></div></div>
        {notice && <div className="notice notice-info" role="status">{notice}</div>}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!loading && packages.length === 0 && <div className="empty-state">{t('noPackagesAvailable')}</div>}
        <div className="package-list">
          {packages.map((item) => (
            <article className="package-card" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>{item.session_count} {t('sessionsWord')} · {formatMoney(item.price_cents, item.currency, locale)}</small>
                {item.description && <small>{item.description}</small>}
              </div>
              <Button variant="primary" size="small" disabled={busy === item.id} onClick={() => buy(item)}>{t('buyPackage')}</Button>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('billingTab')}</span><h3>{t('myInvoices')}</h3></div></div>
        {!loading && invoices.length === 0 && <div className="empty-state">{t('noInvoices')}</div>}
        <div className="invoice-list">
          {invoices.map((invoice) => (
            <article className="invoice-row" key={invoice.id}>
              <div className="invoice-row-main">
                <strong>{invoice.invoice_number}</strong>
                <span>{invoice.description}</span>
                <small>{new Date(invoice.created_at).toLocaleDateString(locale)}{invoice.due_date ? ` · ${t('dueDate')}: ${invoice.due_date}` : ''}</small>
              </div>
              <strong>{formatMoney(invoice.amount_cents, invoice.currency, locale)}</strong>
              <span className={`soft-badge invoice-${invoiceStage(invoice)}`}>{t(invoice.status === 'open' && invoice.payment_reported_at ? 'invoice_waiting' : `invoice_${invoice.status}`)}</span>
              {invoice.status === 'open' && (
                <Button variant="primary" size="small" onClick={() => setOpenInvoice(openInvoice === invoice.id ? '' : invoice.id)} aria-expanded={openInvoice === invoice.id}>{t('howToPay')}</Button>
              )}
              {invoice.status === 'open' && openInvoice === invoice.id && (
                <div className="invoice-pay">
                  <PaymentInstructions coachId={invoice.coach_id} invoiceNumber={invoice.invoice_number} />
                  {invoice.payment_reported_at
                    ? <div className="notice notice-info" role="status">{t('payWaitingConfirm')}</div>
                    : <Button variant="secondary" size="small" disabled={busy === invoice.id} onClick={() => reportPaid(invoice.id)}>{t('payIPaid')}</Button>}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
