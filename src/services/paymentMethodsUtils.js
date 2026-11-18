// How a coach gets paid by their own clients: bank transfer details and/or a method agreed with the client.
// The IBAN rules match public.iban_is_valid() in supabase/migrations/20261115002400_manual_invoice_payments.sql.

export const PAID_METHODS = ['bank_transfer', 'custom', 'cash', 'other'];

export const normalizeIban = (value) => String(value ?? '').toUpperCase().replace(/[\s-]/g, '');

export function ibanIsValid(value) {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let rest = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    rest = /[0-9]/.test(char) ? (rest * 10 + Number(char)) % 97 : (rest * 100 + char.charCodeAt(0) - 55) % 97;
  }
  return rest === 1;
}

// DE89 3704 0044 0532 0130 00
export const formatIban = (value) => normalizeIban(value).replace(/(.{4})/g, '$1 ').trim();

export const emptyPaymentForm = () => ({
  bankEnabled: false, holder: '', bankName: '', iban: '', swift: '', accountNumber: '',
  customEnabled: false, customLabel: '', customInstructions: '', note: '',
});

// The form for the object the database returns ({ bank, custom, note }).
export function formFromMethods(methods) {
  const form = emptyPaymentForm();
  if (!methods) return form;
  if (methods.bank) {
    Object.assign(form, {
      bankEnabled: true,
      holder: methods.bank.account_holder || '',
      bankName: methods.bank.bank_name || '',
      iban: formatIban(methods.bank.iban),
      swift: methods.bank.swift_bic || '',
      accountNumber: methods.bank.account_number || '',
    });
  }
  if (methods.custom) {
    Object.assign(form, { customEnabled: true, customLabel: methods.custom.label || '', customInstructions: methods.custom.instructions || '' });
  }
  form.note = methods.note || '';
  return form;
}

// Checks the form. Error values are translation keys.
export function validatePaymentForm(form) {
  const errors = {};
  const text = (value) => String(value ?? '').trim();
  const iban = normalizeIban(form.iban);
  const swift = text(form.swift).toUpperCase().replace(/\s/g, '');

  if (form.bankEnabled) {
    if (text(form.holder).length < 2 || text(form.holder).length > 120) errors.holder = 'payErrHolder';
    if (!iban && !text(form.accountNumber)) errors.iban = 'payErrBankNumber';
    if (text(form.bankName).length > 120) errors.bankName = 'payErrBankName';
    if (text(form.accountNumber) && (text(form.accountNumber).length < 3 || text(form.accountNumber).length > 60)) errors.accountNumber = 'payErrAccount';
  }
  if (iban && !ibanIsValid(iban)) errors.iban = 'payErrIban';
  if (swift && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) errors.swift = 'payErrSwift';
  if (form.customEnabled) {
    if (text(form.customLabel).length < 2 || text(form.customLabel).length > 60) errors.customLabel = 'payErrCustomLabel';
    if (text(form.customInstructions).length < 3 || text(form.customInstructions).length > 1000) errors.customInstructions = 'payErrCustomText';
  }
  if (text(form.note).length > 500) errors.note = 'payErrNote';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: {
      p_bank_enabled: Boolean(form.bankEnabled),
      p_account_holder: text(form.holder) || null,
      p_bank_name: text(form.bankName) || null,
      p_iban: iban || null,
      p_swift_bic: swift || null,
      p_account_number: text(form.accountNumber) || null,
      p_custom_enabled: Boolean(form.customEnabled),
      p_custom_label: text(form.customLabel) || null,
      p_custom_instructions: text(form.customInstructions) || null,
      p_payment_note: text(form.note) || null,
    },
  };
}

export const paymentsReady = (methods) => Boolean(methods?.bank || methods?.custom);

// The lines a client sees for a bank transfer: [labelKey, value, copyable].
export function bankLines(bank) {
  if (!bank) return [];
  return [
    ['payAccountHolder', bank.account_holder, true],
    ['payBankName', bank.bank_name, false],
    ['payIban', bank.iban ? formatIban(bank.iban) : '', true],
    ['paySwift', bank.swift_bic, true],
    ['payAccountNumber', bank.account_number, true],
  ].filter(([, value]) => value);
}

// The state of an invoice for the coach: open, reported by the client, paid, void.
export const invoiceStage = (invoice) => (invoice.status === 'open' && invoice.payment_reported_at ? 'reported' : invoice.status);