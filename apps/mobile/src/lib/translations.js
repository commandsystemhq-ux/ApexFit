export const SUPPORTED_LOCALES = ['en', 'ar', 'de', 'fr', 'es'];
export const RTL_LOCALES = ['ar'];
export const LOCALE_NAMES = { en: 'English', ar: 'العربية', de: 'Deutsch', fr: 'Français', es: 'Español' };

export const translations = {
  en: {
    appName: 'ApexFit', loading: 'Loading…', retry: 'Try again', errLoad: 'Could not load this.', errConfig: 'The app is not configured yet. Set the Supabase address and key in the .env file.',
    signIn: 'Sign in', signUp: 'Create account', email: 'Email', password: 'Password', fullName: 'Full name', iAmA: 'I am a', roleClient: 'Client', roleCoach: 'Coach',
    continueGoogle: 'Continue with Google', or: 'or', signInInstead: 'I already have an account', createInstead: 'Create a new account', errCredentials: 'Wrong email or password.',
    errRequired: 'Enter your email and password.', checkEmail: 'Check your email to confirm the account, then sign in.', authFailed: 'Sign-in did not finish. Try again.', signOut: 'Sign out',
    tabClients: 'Clients', tabPrograms: 'Programs', tabPlan: 'My plan', tabProgress: 'Progress', tabChat: 'Chat', tabSettings: 'Settings',
    noClients: 'No clients yet. Invite them from the web app.', noPrograms: 'No programs yet.', noPlan: 'Your coach has not assigned a program yet.', noConversations: 'No conversations yet.',
    statusActive: 'Active', statusArchived: 'Archived', openChat: 'Message', days: 'Days', exercises: 'exercises', sets: 'sets', reps: 'reps', rest: 'rest', seconds: 's',
    weightKg: 'Weight today (kg)', saveWeight: 'Save', savedWeight: 'Saved.', errWeight: 'Enter a weight between 20 and 400 kg.', history: 'History', noMetrics: 'No weight logged yet.',
    language: 'Language', restartForDirection: 'Close and reopen the app to apply the reading direction.', account: 'Account', role: 'Role',
    chatPlaceholder: 'Write a message…', send: 'Send', you: 'You', chatClosed: 'This conversation is closed.', sending: 'Sending…', failed: 'Not sent. Tap to retry.',
    voiceRecord: 'Record a voice message', voiceStop: 'Stop', voiceCancel: 'Cancel', voiceSend: 'Send', voicePlay: 'Play', voicePause: 'Pause', voiceMessage: 'Voice message',
    voiceDenied: 'Microphone access is blocked. Allow it in the phone settings and try again.', voiceErrTooShort: 'The recording is too short.', voiceErrTooLong: 'Voice messages can be up to 2 minutes long.',
    voiceErrTooBig: 'The recording is larger than 10 MB.', voiceErrUpload: 'Could not upload the recording.', voiceErrPlay: 'Could not play this recording.', voiceErrRecord: 'Could not start recording.',
  },
  ar: {
    appName: 'ApexFit', loading: 'جارٍ التحميل…', retry: 'حاول مرة أخرى', errLoad: 'تعذر تحميل هذا.', errConfig: 'التطبيق غير مهيأ بعد. أضف عنوان Supabase ومفتاحه في ملف .env.',
    signIn: 'تسجيل الدخول', signUp: 'إنشاء حساب', email: 'البريد الإلكتروني', password: 'كلمة المرور', fullName: 'الاسم الكامل', iAmA: 'أنا', roleClient: 'متدرب', roleCoach: 'مدرب',
    continueGoogle: 'المتابعة باستخدام Google', or: 'أو', signInInstead: 'لدي حساب بالفعل', createInstead: 'إنشاء حساب جديد', errCredentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    errRequired: 'أدخل بريدك الإلكتروني وكلمة المرور.', checkEmail: 'تحقق من بريدك لتأكيد الحساب ثم سجّل الدخول.', authFailed: 'لم يكتمل تسجيل الدخول. حاول مرة أخرى.', signOut: 'تسجيل الخروج',
    tabClients: 'العملاء', tabPrograms: 'البرامج', tabPlan: 'خطتي', tabProgress: 'التقدم', tabChat: 'المحادثات', tabSettings: 'الإعدادات',
    noClients: 'لا يوجد عملاء بعد. ادعُهم من تطبيق الويب.', noPrograms: 'لا توجد برامج بعد.', noPlan: 'لم يعيّن مدربك برنامجًا لك بعد.', noConversations: 'لا توجد محادثات بعد.',
    statusActive: 'نشط', statusArchived: 'مؤرشف', openChat: 'مراسلة', days: 'الأيام', exercises: 'تمارين', sets: 'مجموعات', reps: 'تكرارات', rest: 'راحة', seconds: 'ث',
    weightKg: 'وزن اليوم (كجم)', saveWeight: 'حفظ', savedWeight: 'تم الحفظ.', errWeight: 'أدخل وزنًا بين 20 و400 كجم.', history: 'السجل', noMetrics: 'لم يُسجل أي وزن بعد.',
    language: 'اللغة', restartForDirection: 'أغلق التطبيق وافتحه من جديد لتطبيق اتجاه القراءة.', account: 'الحساب', role: 'الدور',
    chatPlaceholder: 'اكتب رسالة…', send: 'إرسال', you: 'أنت', chatClosed: 'هذه المحادثة مغلقة.', sending: 'جارٍ الإرسال…', failed: 'لم تُرسل. اضغط لإعادة المحاولة.',
    voiceRecord: 'تسجيل رسالة صوتية', voiceStop: 'إيقاف', voiceCancel: 'إلغاء', voiceSend: 'إرسال', voicePlay: 'تشغيل', voicePause: 'إيقاف مؤقت', voiceMessage: 'رسالة صوتية',
    voiceDenied: 'تم حظر الوصول إلى الميكروفون. اسمح به من إعدادات الهاتف ثم حاول مرة أخرى.', voiceErrTooShort: 'التسجيل قصير جدًا.', voiceErrTooLong: 'يمكن أن تصل الرسالة الصوتية إلى دقيقتين.',
    voiceErrTooBig: 'حجم التسجيل أكبر من 10 ميجابايت.', voiceErrUpload: 'تعذر رفع التسجيل.', voiceErrPlay: 'تعذر تشغيل هذا التسجيل.', voiceErrRecord: 'تعذر بدء التسجيل.',
  },
  de: {
    appName: 'ApexFit', loading: 'Wird geladen…', retry: 'Erneut versuchen', errLoad: 'Das konnte nicht geladen werden.', errConfig: 'Die App ist noch nicht eingerichtet. Trage Supabase-Adresse und -Schlüssel in der .env-Datei ein.',
    signIn: 'Anmelden', signUp: 'Konto erstellen', email: 'E-Mail', password: 'Passwort', fullName: 'Vollständiger Name', iAmA: 'Ich bin', roleClient: 'Kunde', roleCoach: 'Trainer',
    continueGoogle: 'Weiter mit Google', or: 'oder', signInInstead: 'Ich habe schon ein Konto', createInstead: 'Neues Konto erstellen', errCredentials: 'E-Mail oder Passwort ist falsch.',
    errRequired: 'Gib E-Mail und Passwort ein.', checkEmail: 'Bestätige das Konto über die E-Mail und melde dich dann an.', authFailed: 'Die Anmeldung wurde nicht abgeschlossen. Versuche es erneut.', signOut: 'Abmelden',
    tabClients: 'Kunden', tabPrograms: 'Programme', tabPlan: 'Mein Plan', tabProgress: 'Fortschritt', tabChat: 'Chat', tabSettings: 'Einstellungen',
    noClients: 'Noch keine Kunden. Lade sie in der Web-App ein.', noPrograms: 'Noch keine Programme.', noPlan: 'Dein Trainer hat dir noch kein Programm zugewiesen.', noConversations: 'Noch keine Unterhaltungen.',
    statusActive: 'Aktiv', statusArchived: 'Archiviert', openChat: 'Nachricht', days: 'Tage', exercises: 'Übungen', sets: 'Sätze', reps: 'Wdh.', rest: 'Pause', seconds: 's',
    weightKg: 'Gewicht heute (kg)', saveWeight: 'Speichern', savedWeight: 'Gespeichert.', errWeight: 'Gib ein Gewicht zwischen 20 und 400 kg ein.', history: 'Verlauf', noMetrics: 'Noch kein Gewicht erfasst.',
    language: 'Sprache', restartForDirection: 'Schließe die App und öffne sie neu, um die Leserichtung zu übernehmen.', account: 'Konto', role: 'Rolle',
    chatPlaceholder: 'Nachricht schreiben…', send: 'Senden', you: 'Du', chatClosed: 'Diese Unterhaltung ist geschlossen.', sending: 'Wird gesendet…', failed: 'Nicht gesendet. Tippen zum Wiederholen.',
    voiceRecord: 'Sprachnachricht aufnehmen', voiceStop: 'Stopp', voiceCancel: 'Abbrechen', voiceSend: 'Senden', voicePlay: 'Abspielen', voicePause: 'Pause', voiceMessage: 'Sprachnachricht',
    voiceDenied: 'Der Mikrofonzugriff ist blockiert. Erlaube ihn in den Telefoneinstellungen und versuche es erneut.', voiceErrTooShort: 'Die Aufnahme ist zu kurz.', voiceErrTooLong: 'Sprachnachrichten dürfen bis zu 2 Minuten lang sein.',
    voiceErrTooBig: 'Die Aufnahme ist größer als 10 MB.', voiceErrUpload: 'Die Aufnahme konnte nicht hochgeladen werden.', voiceErrPlay: 'Die Aufnahme konnte nicht abgespielt werden.', voiceErrRecord: 'Die Aufnahme konnte nicht gestartet werden.',
  },
  fr: {
    appName: 'ApexFit', loading: 'Chargement…', retry: 'Réessayer', errLoad: 'Impossible de charger ceci.', errConfig: 'L\'application n\'est pas encore configurée. Renseignez l\'adresse et la clé Supabase dans le fichier .env.',
    signIn: 'Se connecter', signUp: 'Créer un compte', email: 'E-mail', password: 'Mot de passe', fullName: 'Nom complet', iAmA: 'Je suis', roleClient: 'Client', roleCoach: 'Coach',
    continueGoogle: 'Continuer avec Google', or: 'ou', signInInstead: 'J\'ai déjà un compte', createInstead: 'Créer un nouveau compte', errCredentials: 'E-mail ou mot de passe incorrect.',
    errRequired: 'Saisissez votre e-mail et votre mot de passe.', checkEmail: 'Confirmez le compte depuis votre e-mail, puis connectez-vous.', authFailed: 'La connexion n\'a pas abouti. Réessayez.', signOut: 'Se déconnecter',
    tabClients: 'Clients', tabPrograms: 'Programmes', tabPlan: 'Mon plan', tabProgress: 'Progrès', tabChat: 'Chat', tabSettings: 'Réglages',
    noClients: 'Aucun client pour le moment. Invitez-les depuis l\'application web.', noPrograms: 'Aucun programme pour le moment.', noPlan: 'Votre coach ne vous a pas encore attribué de programme.', noConversations: 'Aucune conversation pour le moment.',
    statusActive: 'Actif', statusArchived: 'Archivé', openChat: 'Écrire', days: 'Jours', exercises: 'exercices', sets: 'séries', reps: 'rép.', rest: 'repos', seconds: 's',
    weightKg: 'Poids du jour (kg)', saveWeight: 'Enregistrer', savedWeight: 'Enregistré.', errWeight: 'Saisissez un poids entre 20 et 400 kg.', history: 'Historique', noMetrics: 'Aucun poids enregistré.',
    language: 'Langue', restartForDirection: 'Fermez et rouvrez l\'application pour appliquer le sens de lecture.', account: 'Compte', role: 'Rôle',
    chatPlaceholder: 'Écrire un message…', send: 'Envoyer', you: 'Vous', chatClosed: 'Cette conversation est fermée.', sending: 'Envoi…', failed: 'Non envoyé. Touchez pour réessayer.',
    voiceRecord: 'Enregistrer un message vocal', voiceStop: 'Arrêter', voiceCancel: 'Annuler', voiceSend: 'Envoyer', voicePlay: 'Lire', voicePause: 'Pause', voiceMessage: 'Message vocal',
    voiceDenied: 'L\'accès au micro est bloqué. Autorisez-le dans les réglages du téléphone puis réessayez.', voiceErrTooShort: 'L\'enregistrement est trop court.', voiceErrTooLong: 'Un message vocal peut durer jusqu\'à 2 minutes.',
    voiceErrTooBig: 'L\'enregistrement dépasse 10 Mo.', voiceErrUpload: 'Impossible d\'envoyer l\'enregistrement.', voiceErrPlay: 'Impossible de lire cet enregistrement.', voiceErrRecord: 'Impossible de démarrer l\'enregistrement.',
  },
  es: {
    appName: 'ApexFit', loading: 'Cargando…', retry: 'Reintentar', errLoad: 'No se pudo cargar esto.', errConfig: 'La app aún no está configurada. Añade la dirección y la clave de Supabase en el archivo .env.',
    signIn: 'Iniciar sesión', signUp: 'Crear cuenta', email: 'Correo', password: 'Contraseña', fullName: 'Nombre completo', iAmA: 'Soy', roleClient: 'Cliente', roleCoach: 'Entrenador',
    continueGoogle: 'Continuar con Google', or: 'o', signInInstead: 'Ya tengo una cuenta', createInstead: 'Crear una cuenta nueva', errCredentials: 'Correo o contraseña incorrectos.',
    errRequired: 'Introduce tu correo y tu contraseña.', checkEmail: 'Confirma la cuenta desde tu correo y luego inicia sesión.', authFailed: 'El inicio de sesión no se completó. Inténtalo de nuevo.', signOut: 'Cerrar sesión',
    tabClients: 'Clientes', tabPrograms: 'Programas', tabPlan: 'Mi plan', tabProgress: 'Progreso', tabChat: 'Chat', tabSettings: 'Ajustes',
    noClients: 'Aún no hay clientes. Invítalos desde la app web.', noPrograms: 'Aún no hay programas.', noPlan: 'Tu entrenador aún no te ha asignado un programa.', noConversations: 'Aún no hay conversaciones.',
    statusActive: 'Activo', statusArchived: 'Archivado', openChat: 'Mensaje', days: 'Días', exercises: 'ejercicios', sets: 'series', reps: 'rep.', rest: 'descanso', seconds: 's',
    weightKg: 'Peso de hoy (kg)', saveWeight: 'Guardar', savedWeight: 'Guardado.', errWeight: 'Introduce un peso entre 20 y 400 kg.', history: 'Historial', noMetrics: 'Aún no hay peso registrado.',
    language: 'Idioma', restartForDirection: 'Cierra y vuelve a abrir la app para aplicar la dirección de lectura.', account: 'Cuenta', role: 'Rol',
    chatPlaceholder: 'Escribe un mensaje…', send: 'Enviar', you: 'Tú', chatClosed: 'Esta conversación está cerrada.', sending: 'Enviando…', failed: 'No enviado. Toca para reintentar.',
    voiceRecord: 'Grabar un mensaje de voz', voiceStop: 'Detener', voiceCancel: 'Cancelar', voiceSend: 'Enviar', voicePlay: 'Reproducir', voicePause: 'Pausar', voiceMessage: 'Mensaje de voz',
    voiceDenied: 'El acceso al micrófono está bloqueado. Permítelo en los ajustes del teléfono e inténtalo de nuevo.', voiceErrTooShort: 'La grabación es demasiado corta.', voiceErrTooLong: 'Los mensajes de voz pueden durar hasta 2 minutos.',
    voiceErrTooBig: 'La grabación supera los 10 MB.', voiceErrUpload: 'No se pudo subir la grabación.', voiceErrPlay: 'No se pudo reproducir la grabación.', voiceErrRecord: 'No se pudo iniciar la grabación.',
  },
};

export function pickLocale(deviceLanguage) {
  const code = String(deviceLanguage || '').toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(code) ? code : 'en';
}

export function isRtlLocale(locale) {
  return RTL_LOCALES.includes(locale);
}

// Missing keys fall back to English, then to the key itself.
export function translate(locale, key) {
  return translations[locale]?.[key] ?? translations.en[key] ?? key;
}