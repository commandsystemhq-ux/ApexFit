// The email a client receives, built from the coach's subject and message. Pure functions: the coach's preview in the
// browser and the real send on the server use this same code, so what the coach sees is what is sent.

export const CAMPAIGN_LANGUAGES = ['en', 'ar', 'de', 'fr', 'es'];
export const RTL_LANGUAGES = ['ar'];
export const CAMPAIGN_VARIABLES = ['client_name', 'coach_name'];
export const CAMPAIGN_SUBJECT_MAX = 150;
export const CAMPAIGN_BODY_MAX = 5000;

const TEXT = {
  en: { fallbackName: 'there', reason: 'You are receiving this email because you are a client of {coach}.', unsubscribe: 'Unsubscribe from these emails' },
  ar: { fallbackName: 'عزيزي المتدرب', reason: 'وصلتك هذه الرسالة لأنك متدرب لدى {coach}.', unsubscribe: 'إلغاء الاشتراك في هذه الرسائل' },
  de: { fallbackName: 'du', reason: 'Du erhältst diese E-Mail, weil du Kunde von {coach} bist.', unsubscribe: 'Diese E-Mails abbestellen' },
  fr: { fallbackName: 'à vous', reason: 'Vous recevez cet e-mail parce que vous êtes client de {coach}.', unsubscribe: 'Se désabonner de ces e-mails' },
  es: { fallbackName: 'amigo', reason: 'Recibes este correo porque eres cliente de {coach}.', unsubscribe: 'Cancelar la suscripción a estos correos' },
};

export function isRtlLanguage(language) {
  return RTL_LANGUAGES.includes(language);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || '';
}

// {{client_name}} and {{coach_name}} (spaces and capitals do not matter). Anything else in double braces is removed
// so a typo never reaches a client as raw text.
export function fillVariables(text, values) {
  return String(text ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => String(values[key.toLowerCase()] ?? ''));
}

export function validateCampaignDraft({ subject, body, language }) {
  const errors = {};
  const subjectText = String(subject ?? '').trim();
  const bodyText = String(body ?? '').trim();
  if (!subjectText) errors.subject = 'campaignErrSubject';
  else if (subjectText.length > CAMPAIGN_SUBJECT_MAX) errors.subject = 'campaignErrSubjectLong';
  if (!bodyText) errors.body = 'campaignErrBody';
  else if (bodyText.length > CAMPAIGN_BODY_MAX) errors.body = 'campaignErrBodyLong';
  if (!CAMPAIGN_LANGUAGES.includes(language)) errors.language = 'campaignErrLanguage';
  return { valid: Object.keys(errors).length === 0, errors, subject: subjectText, body: bodyText };
}

function paragraphs(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 16px;line-height:1.6">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function renderCampaignEmail({ subject, body, language = 'en', clientName = '', coachName = '', unsubscribeUrl = '' }) {
  const lang = CAMPAIGN_LANGUAGES.includes(language) ? language : 'en';
  const labels = TEXT[lang];
  const dir = isRtlLanguage(lang) ? 'rtl' : 'ltr';
  const values = { client_name: firstName(clientName) || labels.fallbackName, coach_name: coachName || 'ApexFit' };
  const finalSubject = fillVariables(subject, values).replace(/[\r\n]+/g, ' ').trim();
  const finalBody = fillVariables(body, values).trim();
  const reason = labels.reason.replace('{coach}', values.coach_name);

  const textParts = [finalBody, '--', reason];
  if (unsubscribeUrl) textParts.push(`${labels.unsubscribe}: ${unsubscribeUrl}`);
  const text = textParts.join('\n\n');
  const unsubscribeHtml = unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">${escapeHtml(labels.unsubscribe)}</a>`
    : '';
  const html = `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:24px;background:#f4f5f7"><div dir="${dir}" style="max-width:560px;margin:0 auto;padding:28px;background:#ffffff;border-radius:12px;`
    + `font-family:-apple-system,Segoe UI,Roboto,Tahoma,Arial,sans-serif;font-size:15px;color:#111827;text-align:${dir === 'rtl' ? 'right' : 'left'}">`
    + `${paragraphs(finalBody)}<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0 16px">`
    + `<p style="margin:0 0 6px;font-size:12px;color:#6b7280">${escapeHtml(reason)}</p>`
    + `<p style="margin:0;font-size:12px">${unsubscribeHtml}</p></div></body></html>`;

  return { subject: finalSubject, text, html, dir };
}

// Status of a recipient row as a translation key.
export function recipientStatusKey(status) {
  return `campaignRecipient_${status}`;
}

export function campaignProgress(campaign) {
  const total = Number(campaign?.total_count) || 0;
  const done = (Number(campaign?.sent_count) || 0) + (Number(campaign?.failed_count) || 0) + (Number(campaign?.skipped_count) || 0);
  return { total, done, percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0 };
}

// Sends a campaign batch by batch until nobody is left. The server limits each call, so every request stays short.
// A batch that handled nobody while people remain stops the loop instead of repeating forever.
export async function runCampaignSend(sendBatch, campaignId, { onProgress, shouldStop = () => false, maxBatches = 100 } = {}) {
  const totals = { sent: 0, failed: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (shouldStop()) return { ...totals, remaining: null, stopped: true };
    const result = await sendBatch(campaignId);
    totals.sent += Number(result.sent) || 0;
    totals.failed += Number(result.failed) || 0;
    const remaining = Number(result.remaining) || 0;
    onProgress?.({ ...totals, remaining });
    if (remaining === 0) return { ...totals, remaining: 0, stopped: false };
    if (!result.sent && !result.failed) return { ...totals, remaining, stopped: true };
  }
  return { ...totals, remaining: null, stopped: true };
}