const TEXT = {
  en: {
    message: ['New message from your coach', 'Open ApexFit to read it.'],
    session: ['Training session update', 'Your coach scheduled or changed a session.'],
    invoice: ['New invoice', 'Your coach sent you an invoice.'],
  },
  ar: {
    message: ['رسالة جديدة من مدربك', 'افتح ApexFit لقراءتها.'],
    session: ['تحديث جلسة التدريب', 'قام مدربك بجدولة جلسة أو تغييرها.'],
    invoice: ['فاتورة جديدة', 'أرسل لك مدربك فاتورة.'],
  },
  de: {
    message: ['Neue Nachricht von deinem Trainer', 'Öffne ApexFit, um sie zu lesen.'],
    session: ['Update zur Trainingseinheit', 'Dein Trainer hat eine Einheit geplant oder geändert.'],
    invoice: ['Neue Rechnung', 'Dein Trainer hat dir eine Rechnung geschickt.'],
  },
  fr: {
    message: ['Nouveau message de votre coach', 'Ouvrez ApexFit pour le lire.'],
    session: ['Mise à jour de séance', 'Votre coach a planifié ou modifié une séance.'],
    invoice: ['Nouvelle facture', 'Votre coach vous a envoyé une facture.'],
  },
  es: {
    message: ['Nuevo mensaje de tu entrenador', 'Abre ApexFit para leerlo.'],
    session: ['Actualización de sesión', 'Tu entrenador programó o cambió una sesión.'],
    invoice: ['Nueva factura', 'Tu entrenador te envió una factura.'],
  },
};

export const NOTIFICATION_TYPES = Object.keys(TEXT.en);

export function buildPushMessage(type, locale) {
  const language = TEXT[locale] ? locale : 'en';
  const entry = TEXT[language][type];
  if (!entry) throw new RangeError(`Unsupported notification type: ${type}`);
  return { title: entry[0], body: entry[1], url: '/#coachHub', tag: `apexfit-${type}` };
}
