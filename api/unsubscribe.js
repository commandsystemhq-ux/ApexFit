import { adminClient } from './_lib/auth.js';
import { ConfigError } from './_lib/config.js';
import { verifyUnsubscribe } from './_lib/emailCampaign.js';
import { handler } from './_lib/http.js';
import { CAMPAIGN_LANGUAGES, escapeHtml, isRtlLanguage } from '../src/services/campaignTemplate.js';

const PAGE_TEXT = {
  en: { title: 'Unsubscribe', ask: 'Stop receiving marketing emails from your coaches on ApexFit?', button: 'Unsubscribe', done: 'You are unsubscribed. You will not receive these emails any more.', invalid: 'This link is not valid.', failed: 'Something went wrong. Please try again later.' },
  ar: { title: 'إلغاء الاشتراك', ask: 'هل تريد التوقف عن استلام الرسائل التسويقية من مدربيك على ApexFit؟', button: 'إلغاء الاشتراك', done: 'تم إلغاء اشتراكك. لن تصلك هذه الرسائل بعد الآن.', invalid: 'هذا الرابط غير صالح.', failed: 'حدث خطأ. حاول مرة أخرى لاحقًا.' },
  de: { title: 'Abmelden', ask: 'Keine Marketing-E-Mails deiner Trainer auf ApexFit mehr erhalten?', button: 'Abmelden', done: 'Du bist abgemeldet. Du erhältst diese E-Mails nicht mehr.', invalid: 'Dieser Link ist ungültig.', failed: 'Etwas ist schiefgelaufen. Bitte versuche es später erneut.' },
  fr: { title: 'Se désabonner', ask: 'Ne plus recevoir les e-mails marketing de vos coachs sur ApexFit ?', button: 'Se désabonner', done: 'Vous êtes désabonné. Vous ne recevrez plus ces e-mails.', invalid: 'Ce lien n\'est pas valide.', failed: 'Une erreur est survenue. Réessayez plus tard.' },
  es: { title: 'Cancelar suscripción', ask: '¿Dejar de recibir los correos de marketing de tus entrenadores en ApexFit?', button: 'Cancelar suscripción', done: 'Te has dado de baja. Ya no recibirás estos correos.', invalid: 'Este enlace no es válido.', failed: 'Algo salió mal. Inténtalo de nuevo más tarde.' },
};

function page(language, message, form = '') {
  const labels = PAGE_TEXT[language];
  const dir = isRtlLanguage(language) ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${escapeHtml(labels.title)}</title></head>`
    + '<body style="margin:0;padding:32px 16px;background:#0b1220;font-family:-apple-system,Segoe UI,Roboto,Tahoma,Arial,sans-serif;color:#e5e7eb">'
    + `<main style="max-width:420px;margin:48px auto;padding:28px;background:#111a2e;border-radius:14px"><h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(labels.title)}</h1>`
    + `<p style="line-height:1.6">${escapeHtml(message)}</p>${form}</main></body></html>`;
}

function send(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(html);
}

function readForm(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
  return {};
}

function secret() {
  const value = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.TOKEN_ENCRYPTION_KEY;
  if (!value) throw new ConfigError('EMAIL_UNSUBSCRIBE_SECRET is not configured on the server.');
  return value;
}

// The unsubscribe link in every campaign email. GET only shows a confirmation button (mail scanners that open links
// must not unsubscribe anyone); POST, from that button or from a mail app's one-click unsubscribe, saves the choice.
export default handler(['GET', 'POST'], async (req, res) => {
  const source = req.method === 'POST' ? { ...(req.query || {}), ...readForm(req) } : (req.query || {});
  const language = CAMPAIGN_LANGUAGES.includes(source.l) ? source.l : 'en';
  const labels = PAGE_TEXT[language];
  const clientId = typeof source.u === 'string' ? source.u : '';
  const token = typeof source.t === 'string' ? source.t : '';

  if (!/^[0-9a-f-]{36}$/i.test(clientId) || !verifyUnsubscribe(clientId, token, secret())) {
    return send(res, 400, page(language, labels.invalid));
  }

  if (req.method === 'GET') {
    const action = `/api/unsubscribe?${new URLSearchParams({ u: clientId, t: token, l: language })}`;
    const form = `<form method="post" action="${escapeHtml(action)}"><button type="submit" style="margin-top:8px;padding:10px 18px;border:0;border-radius:8px;background:#3684f6;color:#fff;font-size:15px;cursor:pointer">${escapeHtml(labels.button)}</button></form>`;
    return send(res, 200, page(language, labels.ask, form));
  }

  const { error } = await adminClient()
    .from('profiles')
    .update({ email_marketing_opt_out: true, email_marketing_opt_out_at: new Date().toISOString() })
    .eq('id', clientId);
  if (error) {
    console.error('Could not save an unsubscribe:', error.message);
    return send(res, 500, page(language, labels.failed));
  }
  return send(res, 200, page(language, labels.done));
});
