import { useEffect, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { bankLines, paymentsReady } from '../services/paymentMethodsUtils.js';
import { getCoachPaymentInfo } from '../services/invoicingService.js';

function CopyValue({ value, label }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(String(value).replace(/\s/g, ''));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button className="text-action pay-copy" type="button" onClick={copy} aria-label={`${t('payCopy')}: ${label}`}>{copied ? t('payCopied') : t('payCopy')}</button>
  );
}

// What a client sees on an open invoice: the coach's bank details and/or agreed method, and the invoice number to quote.
export default function PaymentInstructions({ coachId, invoiceNumber }) {
  const { t } = useLocale();
  const [state, setState] = useState({ loading: true, info: null, error: false });

  useEffect(() => {
    let active = true;
    getCoachPaymentInfo(coachId)
      .then((info) => active && setState({ loading: false, info, error: false }))
      .catch(() => active && setState({ loading: false, info: null, error: true }));
    return () => { active = false; };
  }, [coachId]);

  if (state.loading) return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.error) return <div className="notice notice-error" role="alert">{t('payInfoError')}</div>;
  if (!paymentsReady(state.info)) return <div className="notice notice-info" role="status">{t('payCoachNotReady')}</div>;

  const { bank, custom, note } = state.info;
  return (
    <div className="pay-instructions">
      {bank && (
        <div className="pay-block">
          <strong>{t('payBankTransfer')}</strong>
          <dl>
            {bankLines(bank).map(([key, value, copyable]) => (
              <div key={key}>
                <dt>{t(key)}</dt>
                <dd dir="auto">{value}{copyable && <CopyValue value={value} label={t(key)} />}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {custom && (
        <div className="pay-block">
          <strong dir="auto">{custom.label}</strong>
          <p dir="auto">{custom.instructions}</p>
        </div>
      )}
      {note && <p className="muted-copy" dir="auto">{note}</p>}
      <p className="pay-reference">{t('payReference')}: <strong dir="ltr">{invoiceNumber}</strong> <CopyValue value={invoiceNumber} label={t('payReference')} /></p>
    </div>
  );
}