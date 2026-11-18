import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { formFromMethods, paymentsReady, validatePaymentForm } from '../services/paymentMethodsUtils.js';
import { getMyPaymentMethods, savePaymentMethods } from '../services/invoicingService.js';

// How the coach gets paid by their own clients: bank transfer details and/or a method agreed with them.
// ApexFit never touches this money; clients see these details on their invoices and pay the coach directly.
export default function PaymentMethodsPanel({ onChange }) {
  const { t } = useLocale();
  const [state, setState] = useState({ loading: true, methods: null, error: '' });
  const [form, setForm] = useState(() => formFromMethods(null));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    getMyPaymentMethods()
      .then((methods) => {
        if (!active) return;
        setState({ loading: false, methods, error: '' });
        setForm(formFromMethods(methods));
        onChange?.(paymentsReady(methods));
      })
      .catch((error) => active && setState({ loading: false, methods: null, error: error.message }));
    return () => { active = false; };
  }, []);

  const set = (name) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [name]: value }));
    setMessage('');
  };

  async function save(event) {
    event.preventDefault();
    const result = validatePaymentForm(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setSaving(true);
    try {
      const methods = await savePaymentMethods(result.payload);
      setState({ loading: false, methods, error: '' });
      setForm(formFromMethods(methods));
      setMessage(t('payMethodsSaved'));
      onChange?.(paymentsReady(methods));
      setOpen(false);
    } catch (error) {
      setMessage(`${t('payMethodsSaveError')} ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  const ready = paymentsReady(state.methods);
  const summary = [
    state.methods?.bank && t('payBankTransfer'),
    state.methods?.custom && state.methods.custom.label,
  ].filter(Boolean).join(' \u00B7 ');
  const field = (name, label, props = {}) => (
    <label className="form-label">{label}
      <input className="field" value={form[name]} onChange={set(name)} aria-invalid={Boolean(errors[name])} {...props} />
      {errors[name] && <small className="field-error" role="alert">{t(errors[name])}</small>}
    </label>
  );

  return (
    <section className="panel pay-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">{t('payMethodsEyebrow')}</span><h3>{t('paymentsSetup')}</h3></div>
        <span className={`soft-badge ${ready ? 'badge-blue' : 'badge-muted'}`}>
          {state.loading ? t('loadingProgress') : t(ready ? 'paymentsReady' : 'paymentsNotReady')}
        </span>
      </div>
      <p className="muted-copy">{t('payMethodsHelp')}</p>
      {state.error && <div className="notice notice-error" role="alert">{state.error}</div>}
      {ready && !open && <p className="pay-summary">{t('payMethodsActive')}: <strong dir="auto">{summary}</strong></p>}
      {message && <div className="notice notice-info" role="status">{message}</div>}
      {!state.loading && !open && (
        <Button variant={ready ? 'secondary' : 'primary'} type="button" onClick={() => setOpen(true)}>{t(ready ? 'payMethodsEdit' : 'payMethodsSetUp')}</Button>
      )}
      {open && (
        <form className="pay-form" onSubmit={save} noValidate>
          <fieldset className="pay-method">
            <legend>
              <label className="pay-toggle"><input type="checkbox" checked={form.bankEnabled} onChange={set('bankEnabled')} /> {t('payBankTransfer')}</label>
            </legend>
            {form.bankEnabled && (
              <>
                {field('holder', t('payAccountHolder'), { maxLength: 120, autoComplete: 'off' })}
                {field('bankName', t('payBankName'), { maxLength: 120 })}
                {field('iban', t('payIban'), { maxLength: 48, dir: 'ltr', placeholder: 'DE89 3704 0044 0532 0130 00', autoComplete: 'off' })}
                <div className="form-grid">
                  {field('swift', t('paySwift'), { maxLength: 11, dir: 'ltr', placeholder: 'COBADEFFXXX' })}
                  {field('accountNumber', t('payAccountNumber'), { maxLength: 60, dir: 'ltr' })}
                </div>
                <small className="muted-copy">{t('payBankHint')}</small>
              </>
            )}
          </fieldset>
          <fieldset className="pay-method">
            <legend>
              <label className="pay-toggle"><input type="checkbox" checked={form.customEnabled} onChange={set('customEnabled')} /> {t('payCustomMethod')}</label>
            </legend>
            {form.customEnabled && (
              <>
                {field('customLabel', t('payCustomLabel'), { maxLength: 60, placeholder: t('payCustomLabelPlaceholder') })}
                <label className="form-label">{t('payCustomInstructions')}
                  <textarea className="field" rows={3} maxLength={1000} value={form.customInstructions} onChange={set('customInstructions')} aria-invalid={Boolean(errors.customInstructions)} placeholder={t('payCustomInstructionsPlaceholder')} />
                  {errors.customInstructions && <small className="field-error" role="alert">{t(errors.customInstructions)}</small>}
                </label>
              </>
            )}
          </fieldset>
          <label className="form-label">{t('payNote')}
            <input className="field" maxLength={500} value={form.note} onChange={set('note')} placeholder={t('payNotePlaceholder')} />
            {errors.note && <small className="field-error" role="alert">{t(errors.note)}</small>}
          </label>
          <div className="template-actions">
            <Button variant="primary" type="submit" disabled={saving}>{saving ? t('taskSaving') : t('payMethodsSave')}</Button>
            <Button variant="secondary" type="button" onClick={() => { setOpen(false); setErrors({}); setForm(formFromMethods(state.methods)); }}>{t('chkCancel')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}