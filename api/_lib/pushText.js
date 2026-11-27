const TEXT = {
  en: {
    message: ['New message from your coach', 'Open ApexFit to read it.'],
    session: ['Training session update', 'Your coach scheduled or changed a session.'],
    invoice: ['New invoice', 'Your coach sent you an invoice.'],
    video: ["New video session", "Your coach scheduled a live video session. Open ApexFit to join."],
    chat: ['New message', 'Open ApexFit to read it.'],
    voice: ['New voice message', 'Open ApexFit to listen to it.'],
    image: ['New photo', 'Open ApexFit to view it.'],
    checkin: ['Your check-in was reviewed', 'Your coach left feedback on your weekly check-in.'],
    marketplace_request: ['New contact request', 'A client wants to train with you. Open ApexFit to answer.'],
    marketplace_accepted: ['Request accepted', 'Your coach accepted your request. You can chat now.'],
  },
  ar: {
    message: ['رسالة جديدة من مدربك', 'افتح ApexFit لقراءتها.'],
    session: ['تحديث جلسة التدريب', 'قام مدربك بجدولة جلسة أو تغييرها.'],
    invoice: ['فاتورة جديدة', 'أرسل لك مدربك فاتورة.'],
    video: ["جلسة فيديو جديدة", "حدد مدربك جلسة فيديو مباشرة. افتح ApexFit للانضمام."],
    chat: ['رسالة جديدة', 'افتح ApexFit لقراءتها.'],
    voice: ['رسالة صوتية جديدة', 'افتح ApexFit للاستماع إليها.'],
    image: ['صورة جديدة', 'افتح ApexFit لعرضها.'],
    checkin: ['تمت مراجعة المتابعة الأسبوعية', 'ترك مدربك ملاحظاته على متابعتك الأسبوعية.'],
    marketplace_request: ['طلب تواصل جديد', 'يرغب عميل في التدرّب معك. افتح ApexFit للرد.'],
    marketplace_accepted: ['تم قبول طلبك', 'قبِل المدرب طلبك. يمكنك المحادثة الآن.'],
  },
  de: {
    message: ['Neue Nachricht von deinem Trainer', 'Öffne ApexFit, um sie zu lesen.'],
    session: ['Update zur Trainingseinheit', 'Dein Trainer hat eine Einheit geplant oder geändert.'],
    invoice: ['Neue Rechnung', 'Dein Trainer hat dir eine Rechnung geschickt.'],
    video: ["Neue Videositzung", "Dein Trainer hat eine Live-Videositzung geplant. Öffne ApexFit zum Beitreten."],
    chat: ['Neue Nachricht', 'Öffne ApexFit, um sie zu lesen.'],
    voice: ['Neue Sprachnachricht', 'Öffne ApexFit, um sie anzuhören.'],
    image: ['Neues Foto', 'Öffne ApexFit, um es anzusehen.'],
    checkin: ['Dein Check-in wurde geprüft', 'Dein Trainer hat Feedback zu deinem wöchentlichen Check-in hinterlassen.'],
    marketplace_request: ['Neue Kontaktanfrage', 'Ein Kunde möchte mit dir trainieren. Öffne ApexFit, um zu antworten.'],
    marketplace_accepted: ['Anfrage angenommen', 'Dein Trainer hat deine Anfrage angenommen. Ihr könnt jetzt chatten.'],
  },
  fr: {
    message: ['Nouveau message de votre coach', 'Ouvrez ApexFit pour le lire.'],
    session: ['Mise à jour de séance', 'Votre coach a planifié ou modifié une séance.'],
    invoice: ['Nouvelle facture', 'Votre coach vous a envoyé une facture.'],
    video: ["Nouvelle séance vidéo", "Votre coach a planifié une séance vidéo en direct. Ouvrez ApexFit pour la rejoindre."],
    chat: ['Nouveau message', 'Ouvrez ApexFit pour le lire.'],
    voice: ['Nouveau message vocal', 'Ouvrez ApexFit pour l\'écouter.'],
    image: ['Nouvelle photo', 'Ouvrez ApexFit pour la voir.'],
    checkin: ['Votre bilan a été examiné', 'Votre coach a laissé un retour sur votre bilan hebdomadaire.'],
    marketplace_request: ['Nouvelle demande de contact', 'Un client souhaite s\'entraîner avec vous. Ouvrez ApexFit pour répondre.'],
    marketplace_accepted: ['Demande acceptée', 'Votre coach a accepté votre demande. Vous pouvez discuter maintenant.'],
  },
  es: {
    message: ['Nuevo mensaje de tu entrenador', 'Abre ApexFit para leerlo.'],
    session: ['Actualización de sesión', 'Tu entrenador programó o cambió una sesión.'],
    invoice: ['Nueva factura', 'Tu entrenador te envió una factura.'],
    video: ["Nueva sesión de vídeo", "Tu entrenador programó una sesión de vídeo en directo. Abre ApexFit para unirte."],
    chat: ['Nuevo mensaje', 'Abre ApexFit para leerlo.'],
    voice: ['Nuevo mensaje de voz', 'Abre ApexFit para escucharlo.'],
    image: ['Nueva foto', 'Abre ApexFit para verla.'],
    checkin: ['Revisaron tu seguimiento', 'Tu entrenador dejó comentarios sobre tu seguimiento semanal.'],
    marketplace_request: ['Nueva solicitud de contacto', 'Un cliente quiere entrenar contigo. Abre ApexFit para responder.'],
    marketplace_accepted: ['Solicitud aceptada', 'Tu entrenador aceptó tu solicitud. Ya podéis chatear.'],
  },
};

export const NOTIFICATION_TYPES = Object.keys(TEXT.en);

// Where tapping the notification opens the app.
const PAGE_FOR_TYPE = { video: '/my-sessions', checkin: '/weekly-checkin', marketplace_request: '/marketplace', marketplace_accepted: '/coach-hub' };

// A reminder carries the text its owner wrote, so it is not part of TEXT; it is built from the reminder itself.
export function buildReminderPush({ title, message, link }) {
  return { title: String(title || 'ApexFit').slice(0, 80), body: String(message || '').slice(0, 200), url: link || '/reminders', tag: 'apexfit-reminder' };
}

export function buildPushMessage(type, locale) {
  const language = TEXT[locale] ? locale : 'en';
  const entry = TEXT[language][type];
  if (!entry) throw new RangeError(`Unsupported notification type: ${type}`);
  return { title: entry[0], body: entry[1], url: PAGE_FOR_TYPE[type] || '/coach-hub', tag: `apexfit-${type}` };
}
