export const CONTRACT_LIMITS = { title: 160, content: 20000, signerName: 120, signatureBytes: 300000 };

const SIGNATURE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/;

// Same rule the database enforces: a PNG data URL of reasonable size.
export function isValidSignatureDataUrl(value) {
  return typeof value === 'string' && value.length <= CONTRACT_LIMITS.signatureBytes && SIGNATURE_PATTERN.test(value);
}

export function validateContractForm({ title, content, required }) {
  const errors = {};
  const cleanTitle = String(title ?? '').trim();
  const cleanContent = String(content ?? '').trim();

  if (!cleanTitle) errors.title = 'ctrErrTitle';
  else if (cleanTitle.length > CONTRACT_LIMITS.title) errors.title = 'ctrErrTitleLength';
  if (!cleanContent) errors.content = 'ctrErrContent';
  else if (cleanContent.length > CONTRACT_LIMITS.content) errors.content = 'ctrErrContentLength';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: { title: cleanTitle, content: cleanContent, required: Boolean(required) },
  };
}

// What the client must provide before the sign button works: a typed name, ink on the pad, and consent.
export function validateSignatureInput({ name, hasInk, agreed }) {
  const errors = {};
  const cleanName = String(name ?? '').trim();
  if (cleanName.length < 2 || cleanName.length > CONTRACT_LIMITS.signerName) errors.name = 'ctrErrName';
  if (!hasInk) errors.signature = 'ctrErrSignature';
  if (!agreed) errors.agree = 'ctrErrAgree';
  return { valid: Object.keys(errors).length === 0, errors, name: cleanName };
}

// Signed/pending state of each contract for one client, given that client's signatures.
export function contractStatuses(contracts, signatures) {
  const signedAt = new Map((signatures || []).map((signature) => [signature.contract_id, signature.signed_at]));
  return (contracts || []).map((contract) => ({
    ...contract,
    signed: signedAt.has(contract.id),
    signed_at: signedAt.get(contract.id) || null,
  }));
}

export function countSignatures(contract, activeClientIds) {
  const active = new Set(activeClientIds);
  const signed = (contract.signatures || []).filter((signature) => active.has(signature.client_id)).length;
  return { signed, total: active.size };
}

export function emptyContractDraft(overrides = {}) {
  return { id: null, title: '', content: '', required: false, locked: false, ...overrides };
}

export const CONTRACT_PRESETS = [
  { id: 'waiver', titleKey: 'ctrPresetWaiverTitle', contentKey: 'ctrPresetWaiverBody', required: true },
  { id: 'agreement', titleKey: 'ctrPresetAgreementTitle', contentKey: 'ctrPresetAgreementBody', required: false },
];
