import { aiTranslations } from './aiTranslations.js';
import { billingTranslations } from './billingTranslations.js';
import { businessTranslations } from './businessTranslations.js';
import { campaignTranslations } from './campaignTranslations.js';
import { chatTranslations } from './chatTranslations.js';
import { calorieTranslations } from './calorieTranslations.js';
import { checkinTranslations } from './checkinTranslations.js';
import { checklistTranslations } from './checklistTranslations.js';
import { clientTagTranslations } from './clientTagTranslations.js';
import { communityTranslations } from './communityTranslations.js';
import { customExerciseTranslations } from './customExerciseTranslations.js';
import { dashboardTranslations } from './dashboardTranslations.js';
import { engagementTranslations, jackEngagementTranslations } from './engagementTranslations.js';
import { exerciseVideoTranslations } from './exerciseVideoTranslations.js';
import { growthTranslations, jackGrowthTranslations } from './growthTranslations.js';
import { habitsTranslations } from './habitsTranslations.js';
import { healthTranslations } from './healthTranslations.js';
import { jackAssistantTranslations } from './jackAssistantTranslations.js';
import { jackTranslations } from './jackTranslations.js';
import { launchTranslations } from './launchTranslations.js';
import { liveRoomTranslations } from './liveRoomTranslations.js';
import { mealPlanTranslations } from './mealPlanTranslations.js';
import { paymentsTranslations } from './paymentsTranslations.js';
import { platformTranslations } from './platformTranslations.js';
import { priority2Translations } from './priority2Translations.js';
import { progressionTranslations } from './progressionTranslations.js';
import { ramadanTranslations } from './ramadanTranslations.js';
import { publicPagesTranslations } from './publicPagesTranslations.js';
import { teamErrorTranslations } from './teamErrorTranslations.js';
import { tempoTranslations } from './tempoTranslations.js';
import { uxTranslations } from './uxTranslations.js';
import { workflowTranslations } from './workflowTranslations.js';

export const supportedLocales = ['en', 'ar', 'de', 'fr', 'es'];

export const localeNames = {
  en: 'English',
  ar: 'العربية',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
};

export const translations = {
  en: {
    dashboard: 'Dashboard', generator: 'Plan generator', messages: 'Messages', portal: 'Client portal', home: 'Home',
    billing: 'Billing', settings: 'Settings', main: 'Main', clients: 'Clients', account: 'Account',
    signIn: 'Sign in with Google', signOut: 'Sign out', coachSignIn: 'Coach sign in',
    clientSignIn: 'Client sign in', trial: 'Start 14-day free trial', language: 'Language',
    languageHelp: 'Choose the language used across ApexFit.', settingsTitle: 'Account settings',
    settingsDescription: 'Manage your language and account preferences.', accountRole: 'Account type',
    coach: 'Coach', client: 'Client', signedOut: 'Not signed in', trialStatus: 'Trial status',
    trialing: 'Free trial', active: 'Active', expired: 'Expired', trialEnds: 'Trial ends',
    trialStarted: 'Trial started', plan: 'Coach plan', month: 'month', subscribe: 'Continue for $39/month',
    checkoutUnavailable: 'Subscription checkout is not configured yet. Contact the workspace owner to activate billing.',
    trialExpiredTitle: 'Your free trial has ended', trialExpiredDescription: 'Subscribe to the $39/month Coach plan to continue using coach features.',
    dashboardTitle: 'Your workspace', dashboardDescription: 'Your ApexFit workspace is ready for real client data.',
    emptyClients: 'Your client roster is empty.', emptyClientsHelp: 'Clients will appear here after they join your coaching workspace.',
    activeClients: 'Active clients', monthlyRevenue: 'Monthly revenue', plansCreated: 'Plans created',
    avgAdherence: 'Average adherence', awaitingData: 'Available when your workspace is connected.',
    insights: 'Coaching insights', weeklyAdherence: 'Weekly adherence', clientRoster: 'Client roster',
    noInsights: 'Insights will appear when real client activity is available.',
    noClientData: 'No clients yet', noClientDataHelp: 'Invite a client to start building your coaching roster.',
    createPlan: 'Create a plan', generatorTitle: 'Create a training plan', generatorDescription: 'Enter a client’s requirements to prepare a plan request.',
    planDetails: 'Plan details', clientName: 'Client name', goal: 'Primary goal', trainingDays: 'Training days per week',
    environment: 'Training environment', fullGym: 'Full gym', home: 'Home', bodyweight: 'Bodyweight',
    limitations: 'Injuries or limitations', nutrition: 'Include nutrition planning', generate: 'Generate plan',
    preparing: 'Preparing…', generatorUnavailable: 'Plan generation is not connected to a secure backend yet.', planGenerated: 'Plan request submitted.',
    planOutputTitle: 'Your plan will appear here',
    planOutputDescription: 'Submit a plan request after the secure generation service is configured.',
    messagesTitle: 'Client messages', messagesDescription: 'Send short notes and videos to one client or all of them at once.',
    emptyMessages: 'No conversations yet.', noConversationSelected: 'Select a client conversation to view messages.',
    portalTitle: 'Client portal', portalDescription: 'Your coach’s shared plans and check-ins will appear here.',
    portalSignIn: 'Sign in as a client to view your portal.', portalEmpty: 'No plans have been shared with this account yet.',
    billingTitle: 'Your subscription', billingDescription: 'Coach access includes a 14-day free trial, then $39 per month.',
    landingPlatform: 'Platform', landingPricing: 'Pricing', landingPill: 'COACHING, BUILT AROUND YOU',
    landingHeadlineOne: 'More coaching.', landingHeadlineTwo: 'Less busywork.',
    landingDescription: 'A focused workspace for fitness coaches to organize their clients and coaching practice.',
    explore: 'Explore the workspace', landingFeatureHeading: 'A clearer way to coach.',
    featurePlans: 'Plan your coaching', featurePlansText: 'Build your workflow around each client’s goals.',
    featureClients: 'Organize your roster', featureClientsText: 'Keep coaching work in one focused workspace.',
    featureGrowth: 'Grow with confidence', featureGrowthText: 'Start with a simple plan and predictable pricing.',
    pricingHeading: 'One plan. No surprises.', pricingDescription: '14 days free, then $39/month for coaches.',
    pricingDetails: 'Coach plan', pricingFeature1: '14-day free trial', pricingFeature2: 'One flat monthly price',
    pricingFeature3: 'Cancel through your billing account',     signInError: 'Unable to sign in.', coachRequiredTitle: 'Coach sign-in required',
    coachRequiredDescription: 'Sign in with Google as a coach to access this workspace.',
    accountLoading: 'Loading account details…', openNavigation: 'Open navigation',
    notConfigured: 'Supabase is not configured. Add the project URL and publishable key to .env.local.',
    noAccount: 'Account details are not available.', accessRequired: 'Coach access is required for this page.',
    saveError: 'Could not save your language preference.',
  },
  ar: {
    dashboard: 'لوحة التحكم', generator: 'إنشاء خطة', messages: 'الرسائل', portal: 'بوابة العميل', home: 'الرئيسية',
    billing: 'الفوترة', settings: 'الإعدادات', main: 'الرئيسية', clients: 'العملاء', account: 'الحساب',
    signIn: 'تسجيل الدخول باستخدام Google', signOut: 'تسجيل الخروج', coachSignIn: 'دخول المدرب',
    clientSignIn: 'دخول العميل', trial: 'ابدأ تجربة مجانية لمدة ١٤ يوماً', language: 'اللغة',
    languageHelp: 'اختر اللغة المستخدمة في ApexFit.', settingsTitle: 'إعدادات الحساب',
    settingsDescription: 'إدارة اللغة وتفضيلات الحساب.', accountRole: 'نوع الحساب',
    coach: 'مدرب', client: 'عميل', signedOut: 'لم يتم تسجيل الدخول', trialStatus: 'حالة التجربة',
    trialing: 'تجربة مجانية', active: 'نشط', expired: 'منتهية', trialEnds: 'تنتهي التجربة',
    trialStarted: 'بدأت التجربة', plan: 'خطة المدرب', month: 'شهرياً', subscribe: 'تابع مقابل ٣٩ دولاراً شهرياً',
    checkoutUnavailable: 'لم يتم إعداد الدفع بعد. تواصل مع مالك مساحة العمل لتفعيل الفوترة.',
    trialExpiredTitle: 'انتهت تجربتك المجانية', trialExpiredDescription: 'اشترك في خطة المدرب مقابل ٣٩ دولاراً شهرياً لمتابعة استخدام ميزات المدرب.',
    dashboardTitle: 'مساحة العمل', dashboardDescription: 'مساحة ApexFit جاهزة لبيانات العملاء الحقيقية.',
    emptyClients: 'قائمة عملائك فارغة.', emptyClientsHelp: 'سيظهر العملاء هنا بعد انضمامهم إلى مساحة التدريب.',
    activeClients: 'العملاء النشطون', monthlyRevenue: 'الإيرادات الشهرية', plansCreated: 'الخطط المنشأة',
    avgAdherence: 'متوسط الالتزام', awaitingData: 'ستتوفر عند ربط بيانات مساحة العمل.',
    insights: 'رؤى التدريب', weeklyAdherence: 'الالتزام الأسبوعي', clientRoster: 'قائمة العملاء',
    noInsights: 'ستظهر الرؤى عند توفر نشاط حقيقي للعملاء.',
    noClientData: 'لا يوجد عملاء بعد', noClientDataHelp: 'ادعُ عميلاً لبدء إنشاء قائمة التدريب.',
    createPlan: 'إنشاء خطة', generatorTitle: 'إنشاء خطة تدريب', generatorDescription: 'أدخل متطلبات العميل لإعداد طلب الخطة.',
    planDetails: 'تفاصيل الخطة', clientName: 'اسم العميل', goal: 'الهدف الأساسي', trainingDays: 'أيام التدريب أسبوعياً',
    environment: 'مكان التدريب', fullGym: 'نادي كامل', home: 'المنزل', bodyweight: 'وزن الجسم',
    limitations: 'الإصابات أو القيود', nutrition: 'تضمين خطة التغذية', generate: 'إنشاء الخطة',
    preparing: 'جارٍ الإعداد…', generatorUnavailable: 'لم يتم ربط إنشاء الخطط بخادم آمن بعد.', planGenerated: 'تم إرسال طلب الخطة.',
    planOutputTitle: 'ستظهر خطتك هنا',
    planOutputDescription: 'أرسل طلب الخطة بعد إعداد خدمة الإنشاء الآمنة.',
    messagesTitle: 'رسائل العملاء', messagesDescription: 'أرسل ملاحظات قصيرة ومقاطع فيديو لعميل واحد أو لكل عملائك دفعة واحدة.',
    emptyMessages: 'لا توجد محادثات بعد.', noConversationSelected: 'اختر محادثة عميل لعرض الرسائل.',
    portalTitle: 'بوابة العميل', portalDescription: 'ستظهر الخطط والتحديثات التي يشاركها مدربك هنا.',
    portalSignIn: 'سجل الدخول كعميل لعرض بوابتك.', portalEmpty: 'لم تتم مشاركة أي خطط مع هذا الحساب بعد.',
    billingTitle: 'اشتراكك', billingDescription: 'يتضمن حساب المدرب تجربة مجانية لمدة ١٤ يوماً، ثم ٣٩ دولاراً شهرياً.',
    landingPlatform: 'المنصة', landingPricing: 'الأسعار', landingPill: 'تدريب مصمم خصيصاً لك',
    landingHeadlineOne: 'تدريب أكثر.', landingHeadlineTwo: 'أعمال روتينية أقل.',
    landingDescription: 'مساحة عمل مركزة لمدربي اللياقة لتنظيم العملاء وممارسة التدريب.',
    explore: 'استكشف مساحة العمل', landingFeatureHeading: 'طريقة أوضح للتدريب.',
    featurePlans: 'خطط تدريبك', featurePlansText: 'أنشئ سير عمل يناسب أهداف كل عميل.',
    featureClients: 'نظم قائمة العملاء', featureClientsText: 'اجمع أعمال التدريب في مساحة عمل واحدة.',
    featureGrowth: 'انمُ بثقة', featureGrowthText: 'ابدأ بخطة بسيطة وسعر واضح.',
    pricingHeading: 'خطة واحدة. بلا مفاجآت.', pricingDescription: '١٤ يوماً مجاناً، ثم ٣٩ دولاراً شهرياً للمدربين.',
    pricingDetails: 'خطة المدرب', pricingFeature1: 'تجربة مجانية لمدة ١٤ يوماً', pricingFeature2: 'سعر شهري ثابت',
    pricingFeature3: 'إلغاء الاشتراك من حساب الفوترة', signInError: 'تعذر تسجيل الدخول.',
    notConfigured: 'لم يتم إعداد Supabase. أضف رابط المشروع ومفتاح النشر إلى .env.local.',
    noAccount: 'تفاصيل الحساب غير متاحة.', accessRequired: 'يلزم حساب مدرب لعرض هذه الصفحة.',
    saveError: 'تعذر حفظ تفضيل اللغة.', coachRequiredTitle: 'يلزم تسجيل دخول المدرب',
    coachRequiredDescription: 'سجل الدخول باستخدام Google كمدرب للوصول إلى مساحة العمل.',
    accountLoading: 'جارٍ تحميل تفاصيل الحساب…', openNavigation: 'فتح التنقل',
  },
  de: {
    dashboard: 'Dashboard', generator: 'Trainingsplan', messages: 'Nachrichten', portal: 'Kundenportal', home: 'Startseite',
    billing: 'Abrechnung', settings: 'Einstellungen', main: 'Hauptmenü', clients: 'Kunden', account: 'Konto',
    signIn: 'Mit Google anmelden', signOut: 'Abmelden', coachSignIn: 'Trainer-Login',
    clientSignIn: 'Kunden-Login', trial: '14 Tage kostenlos testen', language: 'Sprache',
    languageHelp: 'Wähle die Sprache für ApexFit.', settingsTitle: 'Kontoeinstellungen',
    settingsDescription: 'Sprache und Kontoeinstellungen verwalten.', accountRole: 'Kontotyp',
    coach: 'Trainer', client: 'Kunde', signedOut: 'Nicht angemeldet', trialStatus: 'Teststatus',
    trialing: 'Kostenlose Testphase', active: 'Aktiv', expired: 'Abgelaufen', trialEnds: 'Testphase endet',
    trialStarted: 'Testphase gestartet', plan: 'Trainer-Tarif', month: 'Monat', subscribe: 'Für 39 $/Monat fortfahren',
    checkoutUnavailable: 'Der Abonnementabschluss ist noch nicht eingerichtet. Wende dich an den Workspace-Inhaber.',
    trialExpiredTitle: 'Deine kostenlose Testphase ist beendet', trialExpiredDescription: 'Abonniere den Trainer-Tarif für 39 $ pro Monat, um Trainerfunktionen weiter zu nutzen.',
    dashboardTitle: 'Dein Workspace', dashboardDescription: 'Dein ApexFit-Workspace ist bereit für echte Kundendaten.',
    emptyClients: 'Deine Kundenliste ist leer.', emptyClientsHelp: 'Kunden erscheinen hier, sobald sie deinem Coaching-Workspace beitreten.',
    activeClients: 'Aktive Kunden', monthlyRevenue: 'Monatlicher Umsatz', plansCreated: 'Erstellte Pläne',
    avgAdherence: 'Durchschnittliche Teilnahme', awaitingData: 'Verfügbar, sobald dein Workspace verbunden ist.',
    insights: 'Coaching-Einblicke', weeklyAdherence: 'Wöchentliche Teilnahme', clientRoster: 'Kundenliste',
    noInsights: 'Einblicke erscheinen, sobald echte Kundenaktivitäten verfügbar sind.',
    noClientData: 'Noch keine Kunden', noClientDataHelp: 'Lade einen Kunden ein, um deine Coaching-Liste aufzubauen.',
    createPlan: 'Plan erstellen', generatorTitle: 'Trainingsplan erstellen', generatorDescription: 'Gib die Anforderungen eines Kunden für einen Planentwurf ein.',
    planDetails: 'Plandetails', clientName: 'Kundenname', goal: 'Hauptziel', trainingDays: 'Trainingstage pro Woche',
    environment: 'Trainingsumgebung', fullGym: 'Fitnessstudio', home: 'Zuhause', bodyweight: 'Eigengewicht',
    limitations: 'Verletzungen oder Einschränkungen', nutrition: 'Ernährungsplanung einschließen', generate: 'Plan erstellen',
    preparing: 'Wird vorbereitet…', generatorUnavailable: 'Die Planerstellung ist noch nicht mit einem sicheren Backend verbunden.', planGenerated: 'Plananfrage gesendet.',
    planOutputTitle: 'Dein Plan erscheint hier',
    planOutputDescription: 'Sende eine Plananfrage, sobald der sichere Generierungsdienst eingerichtet ist.',
    messagesTitle: 'Kundennachrichten', messagesDescription: 'Sende kurze Notizen und Videos an einen oder alle Kunden gleichzeitig.',
    emptyMessages: 'Noch keine Gespräche.', noConversationSelected: 'Wähle ein Kundengespräch aus, um Nachrichten zu sehen.',
    portalTitle: 'Kundenportal', portalDescription: 'Geteilte Pläne und Check-ins deines Trainers erscheinen hier.',
    portalSignIn: 'Melde dich als Kunde an, um dein Portal zu öffnen.', portalEmpty: 'Für dieses Konto wurden noch keine Pläne freigegeben.',
    billingTitle: 'Dein Abonnement', billingDescription: 'Trainer erhalten 14 Tage kostenlos, danach kostet der Tarif 39 $ pro Monat.',
    landingPlatform: 'Plattform', landingPricing: 'Preise', landingPill: 'COACHING, DAS ZU DIR PASST',
    landingHeadlineOne: 'Mehr Coaching.', landingHeadlineTwo: 'Weniger Aufwand.',
    landingDescription: 'Ein fokussierter Workspace für Fitnesstrainer zur Organisation ihrer Kunden und ihres Coachings.',
    explore: 'Workspace ansehen', landingFeatureHeading: 'Klarer coachen.',
    featurePlans: 'Coaching planen', featurePlansText: 'Gestalte deinen Ablauf passend zu den Zielen jedes Kunden.',
    featureClients: 'Kunden organisieren', featureClientsText: 'Bündle deine Coaching-Arbeit in einem Workspace.',
    featureGrowth: 'Sicher wachsen', featureGrowthText: 'Starte mit einem einfachen Tarif und transparenten Preisen.',
    pricingHeading: 'Ein Tarif. Keine Überraschungen.', pricingDescription: '14 Tage kostenlos, danach 39 $ pro Monat.',
    pricingDetails: 'Trainer-Tarif', pricingFeature1: '14 Tage kostenlos testen', pricingFeature2: 'Ein fester Monatspreis',
    pricingFeature3: 'Kündigung über dein Abrechnungskonto', signInError: 'Anmeldung nicht möglich.',
    notConfigured: 'Supabase ist nicht konfiguriert. Projekt-URL und Publishable Key in .env.local eintragen.',
    noAccount: 'Kontodetails sind nicht verfügbar.', accessRequired: 'Für diese Seite ist ein Trainerkonto erforderlich.',
    saveError: 'Die Spracheinstellung konnte nicht gespeichert werden.', coachRequiredTitle: 'Trainer-Login erforderlich',
    coachRequiredDescription: 'Melde dich als Trainer mit Google an, um auf diesen Workspace zuzugreifen.',
    accountLoading: 'Kontodetails werden geladen…', openNavigation: 'Navigation öffnen',
  },
  fr: {
    dashboard: 'Tableau de bord', generator: 'Plan d’entraînement', messages: 'Messages', portal: 'Portail client', home: 'Accueil',
    billing: 'Facturation', settings: 'Paramètres', main: 'Principal', clients: 'Clients', account: 'Compte',
    signIn: 'Continuer avec Google', signOut: 'Déconnexion', coachSignIn: 'Connexion coach',
    clientSignIn: 'Connexion client', trial: 'Essai gratuit de 14 jours', language: 'Langue',
    languageHelp: 'Choisissez la langue utilisée dans ApexFit.', settingsTitle: 'Paramètres du compte',
    settingsDescription: 'Gérez la langue et les préférences du compte.', accountRole: 'Type de compte',
    coach: 'Coach', client: 'Client', signedOut: 'Non connecté', trialStatus: 'État de l’essai',
    trialing: 'Essai gratuit', active: 'Actif', expired: 'Expiré', trialEnds: 'Fin de l’essai',
    trialStarted: 'Début de l’essai', plan: 'Offre Coach', month: 'mois', subscribe: 'Continuer pour 39 $/mois',
    checkoutUnavailable: 'Le paiement de l’abonnement n’est pas encore configuré. Contactez le propriétaire de l’espace.',
    trialExpiredTitle: 'Votre essai gratuit est terminé', trialExpiredDescription: 'Abonnez-vous à l’offre Coach à 39 $/mois pour continuer à utiliser les fonctions coach.',
    dashboardTitle: 'Votre espace', dashboardDescription: 'Votre espace ApexFit est prêt à accueillir de vraies données clients.',
    emptyClients: 'Votre liste de clients est vide.', emptyClientsHelp: 'Les clients apparaîtront ici après avoir rejoint votre espace de coaching.',
    activeClients: 'Clients actifs', monthlyRevenue: 'Revenus mensuels', plansCreated: 'Plans créés',
    avgAdherence: 'Assiduité moyenne', awaitingData: 'Disponible lorsque votre espace sera connecté.',
    insights: 'Conseils de coaching', weeklyAdherence: 'Assiduité hebdomadaire', clientRoster: 'Liste des clients',
    noInsights: 'Les conseils apparaîtront lorsque des activités clients réelles seront disponibles.',
    noClientData: 'Aucun client pour le moment', noClientDataHelp: 'Invitez un client pour commencer votre liste de coaching.',
    createPlan: 'Créer un plan', generatorTitle: 'Créer un plan d’entraînement', generatorDescription: 'Saisissez les besoins d’un client pour préparer une demande de plan.',
    planDetails: 'Détails du plan', clientName: 'Nom du client', goal: 'Objectif principal', trainingDays: 'Jours d’entraînement par semaine',
    environment: 'Lieu d’entraînement', fullGym: 'Salle complète', home: 'À domicile', bodyweight: 'Poids du corps',
    limitations: 'Blessures ou limitations', nutrition: 'Inclure la nutrition', generate: 'Générer le plan',
    preparing: 'Préparation…', generatorUnavailable: 'La génération de plans n’est pas encore reliée à un serveur sécurisé.', planGenerated: 'Demande de plan envoyée.',
    planOutputTitle: 'Votre plan apparaîtra ici',
    planOutputDescription: 'Envoyez une demande lorsque le service sécurisé de génération sera configuré.',
    messagesTitle: 'Messages clients', messagesDescription: 'Envoyez de courtes notes et vidéos à un client ou à tous en une fois.',
    emptyMessages: 'Aucune conversation pour le moment.', noConversationSelected: 'Sélectionnez une conversation client pour afficher les messages.',
    portalTitle: 'Portail client', portalDescription: 'Les plans et suivis partagés par votre coach apparaîtront ici.',
    portalSignIn: 'Connectez-vous comme client pour accéder à votre portail.', portalEmpty: 'Aucun plan n’a encore été partagé avec ce compte.',
    billingTitle: 'Votre abonnement', billingDescription: 'L’accès coach comprend 14 jours d’essai, puis coûte 39 $ par mois.',
    landingPlatform: 'Plateforme', landingPricing: 'Tarifs', landingPill: 'LE COACHING, À VOTRE RYTHME',
    landingHeadlineOne: 'Plus de coaching.', landingHeadlineTwo: 'Moins de tâches.',
    landingDescription: 'Un espace dédié aux coachs sportifs pour organiser leurs clients et leur activité.',
    explore: 'Découvrir l’espace', landingFeatureHeading: 'Une approche plus claire.',
    featurePlans: 'Planifier votre coaching', featurePlansText: 'Adaptez votre méthode aux objectifs de chaque client.',
    featureClients: 'Organiser votre équipe', featureClientsText: 'Réunissez votre activité dans un espace dédié.',
    featureGrowth: 'Grandir sereinement', featureGrowthText: 'Commencez avec un tarif simple et prévisible.',
    pricingHeading: 'Un tarif. Sans surprise.', pricingDescription: '14 jours gratuits, puis 39 $/mois pour les coachs.',
    pricingDetails: 'Offre Coach', pricingFeature1: '14 jours d’essai gratuit', pricingFeature2: 'Un tarif mensuel fixe',
    pricingFeature3: 'Résiliation via votre compte de facturation', signInError: 'Connexion impossible.',
    notConfigured: 'Supabase n’est pas configuré. Ajoutez l’URL du projet et la clé publique dans .env.local.',
    noAccount: 'Les informations du compte ne sont pas disponibles.', accessRequired: 'Un compte coach est requis pour cette page.',
    saveError: 'Impossible d’enregistrer votre préférence linguistique.', coachRequiredTitle: 'Connexion coach requise',
    coachRequiredDescription: 'Connectez-vous avec Google en tant que coach pour accéder à cet espace.',
    accountLoading: 'Chargement des informations du compte…', openNavigation: 'Ouvrir la navigation',
  },
  es: {
    dashboard: 'Panel', generator: 'Plan de entrenamiento', messages: 'Mensajes', portal: 'Portal del cliente', home: 'Inicio',
    billing: 'Facturación', settings: 'Configuración', main: 'Principal', clients: 'Clientes', account: 'Cuenta',
    signIn: 'Iniciar sesión con Google', signOut: 'Cerrar sesión', coachSignIn: 'Acceso de entrenador',
    clientSignIn: 'Acceso de cliente', trial: 'Prueba gratis de 14 días', language: 'Idioma',
    languageHelp: 'Elige el idioma de ApexFit.', settingsTitle: 'Configuración de la cuenta',
    settingsDescription: 'Administra el idioma y las preferencias de tu cuenta.', accountRole: 'Tipo de cuenta',
    coach: 'Entrenador', client: 'Cliente', signedOut: 'No has iniciado sesión', trialStatus: 'Estado de prueba',
    trialing: 'Prueba gratuita', active: 'Activa', expired: 'Caducada', trialEnds: 'La prueba termina',
    trialStarted: 'Prueba iniciada', plan: 'Plan de entrenador', month: 'mes', subscribe: 'Continuar por 39 $/mes',
    checkoutUnavailable: 'El pago de la suscripción aún no está configurado. Contacta con el propietario del espacio.',
    trialExpiredTitle: 'Tu prueba gratuita ha terminado', trialExpiredDescription: 'Suscríbete al plan de entrenador por 39 $ al mes para seguir usando las funciones de entrenador.',
    dashboardTitle: 'Tu espacio de trabajo', dashboardDescription: 'Tu espacio de ApexFit está listo para datos reales de clientes.',
    emptyClients: 'Tu lista de clientes está vacía.', emptyClientsHelp: 'Los clientes aparecerán aquí cuando se unan a tu espacio de entrenamiento.',
    activeClients: 'Clientes activos', monthlyRevenue: 'Ingresos mensuales', plansCreated: 'Planes creados',
    avgAdherence: 'Adherencia media', awaitingData: 'Disponible cuando se conecten los datos del espacio.',
    insights: 'Información de entrenamiento', weeklyAdherence: 'Adherencia semanal', clientRoster: 'Lista de clientes',
    noInsights: 'La información aparecerá cuando haya actividad real de clientes.',
    noClientData: 'Aún no hay clientes', noClientDataHelp: 'Invita a un cliente para empezar tu lista de entrenamiento.',
    createPlan: 'Crear un plan', generatorTitle: 'Crear un plan de entrenamiento', generatorDescription: 'Introduce las necesidades del cliente para preparar una solicitud de plan.',
    planDetails: 'Detalles del plan', clientName: 'Nombre del cliente', goal: 'Objetivo principal', trainingDays: 'Días de entrenamiento por semana',
    environment: 'Lugar de entrenamiento', fullGym: 'Gimnasio completo', home: 'Casa', bodyweight: 'Peso corporal',
    limitations: 'Lesiones o limitaciones', nutrition: 'Incluir planificación nutricional', generate: 'Generar plan',
    preparing: 'Preparando…', generatorUnavailable: 'La generación de planes aún no está conectada a un servidor seguro.', planGenerated: 'Solicitud del plan enviada.',
    planOutputTitle: 'Tu plan aparecerá aquí',
    planOutputDescription: 'Envía una solicitud cuando el servicio seguro de generación esté configurado.',
    messagesTitle: 'Mensajes a clientes', messagesDescription: 'Envía notas breves y vídeos a un cliente o a todos a la vez.',
    emptyMessages: 'Aún no hay conversaciones.', noConversationSelected: 'Selecciona una conversación para ver los mensajes.',
    portalTitle: 'Portal del cliente', portalDescription: 'Aquí aparecerán los planes y seguimientos compartidos por tu entrenador.',
    portalSignIn: 'Inicia sesión como cliente para ver tu portal.', portalEmpty: 'Aún no se han compartido planes con esta cuenta.',
    billingTitle: 'Tu suscripción', billingDescription: 'El acceso de entrenador incluye 14 días de prueba y después cuesta 39 $ al mes.',
    landingPlatform: 'Plataforma', landingPricing: 'Precios', landingPill: 'ENTRENAMIENTO A TU MANERA',
    landingHeadlineOne: 'Más entrenamiento.', landingHeadlineTwo: 'Menos tareas.',
    landingDescription: 'Un espacio para que los entrenadores de fitness organicen a sus clientes y su trabajo.',
    explore: 'Explorar el espacio', landingFeatureHeading: 'Una forma más clara de entrenar.',
    featurePlans: 'Planifica tu entrenamiento', featurePlansText: 'Adapta tu flujo de trabajo a los objetivos de cada cliente.',
    featureClients: 'Organiza a tus clientes', featureClientsText: 'Reúne tu trabajo de entrenamiento en un solo espacio.',
    featureGrowth: 'Crece con confianza', featureGrowthText: 'Empieza con un plan sencillo y un precio predecible.',
    pricingHeading: 'Un plan. Sin sorpresas.', pricingDescription: '14 días gratis y luego 39 $ al mes para entrenadores.',
    pricingDetails: 'Plan de entrenador', pricingFeature1: 'Prueba gratis de 14 días', pricingFeature2: 'Un precio mensual fijo',
    pricingFeature3: 'Cancela desde tu cuenta de facturación', signInError: 'No se pudo iniciar sesión.',
    notConfigured: 'Supabase no está configurado. Añade la URL del proyecto y la clave pública a .env.local.',
    noAccount: 'Los datos de la cuenta no están disponibles.', accessRequired: 'Se requiere una cuenta de entrenador para esta página.',
    saveError: 'No se pudo guardar la preferencia de idioma.', coachRequiredTitle: 'Se requiere acceso de entrenador',
    coachRequiredDescription: 'Inicia sesión con Google como entrenador para acceder a este espacio.',
    accountLoading: 'Cargando los datos de la cuenta…', openNavigation: 'Abrir navegación',
  },
};

const workoutTranslations = {
  en: {
    exerciseLibrary: 'Exercise library', exerciseLibraryDescription: 'Search and filter the published exercise catalog, including real demo videos.',
    exerciseInstructions: 'Instructions',
    searchExercises: 'Search exercises', searchExercisePlaceholder: 'Search in English or your language (push-up, ضغط, Kniebeuge...)', category: 'Category',
    allCategories: 'All categories', equipment: 'Equipment', allEquipment: 'All equipment', muscleGroup: 'Muscle group',
    allMuscles: 'All muscle groups', difficulty: 'Difficulty', allDifficulties: 'All levels', noExerciseResults: 'No exercises match these filters.',
    emptyExerciseLibrary: 'No published exercises are available yet. Import a verified exercise catalog to populate this library.',
    loadingExercises: 'Loading exercises…', exerciseLoadError: 'Could not load exercises.', exercises: 'exercises',
    page: 'Page', previous: 'Previous', next: 'Next', demoVideo: 'Watch demo', videoUnavailable: 'Video unavailable',
    videoUnsupported: 'This browser cannot play this video.', close: 'Close',
    category_strength: 'Strength', category_cardio: 'Cardio', category_mobility: 'Mobility', category_plyometrics: 'Plyometrics', category_warmup: 'Warm-up',
    equipment_barbell: 'Barbell', equipment_dumbbell: 'Dumbbell', equipment_kettlebell: 'Kettlebell', equipment_cable: 'Cable',
    equipment_machine: 'Machine', equipment_resistance_band: 'Resistance band', equipment_bodyweight: 'Bodyweight', equipment_medicine_ball: 'Medicine ball',
    equipment_bench: 'Bench', equipment_smith_machine: 'Smith machine', equipment_trap_bar: 'Trap bar', equipment_landmine: 'Landmine',
    equipment_plyometric_box: 'Plyometric box', equipment_suspension_trainer: 'Suspension trainer', equipment_foam_roller: 'Foam roller', equipment_exercise_ball: 'Exercise ball', equipment_other: 'Other',
    muscle_chest: 'Chest', muscle_back: 'Back', muscle_shoulders: 'Shoulders', muscle_biceps: 'Biceps', muscle_triceps: 'Triceps', muscle_forearms: 'Forearms',
    muscle_quadriceps: 'Quadriceps', muscle_hamstrings: 'Hamstrings', muscle_glutes: 'Glutes', muscle_calves: 'Calves', muscle_core: 'Core', muscle_full_body: 'Full body',
    muscle_lower_back: 'Lower back', muscle_traps: 'Trapezius', muscle_neck: 'Neck', muscle_hip_flexors: 'Hip flexors', muscle_adductors: 'Adductors', muscle_abductors: 'Abductors',
    difficulty_beginner: 'Beginner', difficulty_intermediate: 'Intermediate', difficulty_advanced: 'Advanced',
    workoutBuilder: 'Workout builder', workoutBuilderDescription: 'Build and save training programs manually by arranging real exercises into training days.',
    programDetails: 'Program details', editProgram: 'Edit program', newProgram: 'New program', startNewProgram: 'Start a new program', days: 'days',
    savedPrograms: 'Saved programs', selectProgram: 'Choose a saved program', loadProgram: 'Load program',
    loadingProgram: 'Loading…', loadProgramError: 'Could not load program.', programLoadError: 'Could not load saved programs.',
    programTitle: 'Program name', programDescription: 'Description', programTitleRequired: 'Enter a program name.',
    day: 'Day', addDay: 'Add day', dayName: 'Training day name', moveUp: 'Move up', moveDown: 'Move down',
    removeDay: 'Remove day', addExercise: 'Add', addExercises: 'Add exercises', addExerciseHint: 'Choose exercises from the library to build this day.',
    unavailableExercise: 'Exercise unavailable', removeExercise: 'Remove exercise', sets: 'Sets', reps: 'Reps',
    restSeconds: 'Rest (seconds)', notes: 'Notes', saveProgram: 'Save program', savingProgram: 'Saving…',
    programSaved: 'Program saved.', saveProgramError: 'Could not save program.',
  },
  ar: {
    exerciseLibrary: 'مكتبة التمارين', exerciseLibraryDescription: 'ابحث في كتالوج التمارين المنشورة وصفِّ النتائج، بما فيها فيديوهات العرض الحقيقية.',
    exerciseInstructions: 'طريقة الأداء',
    searchExercises: 'ابحث عن تمرين', searchExercisePlaceholder: 'ابحث بالعربية أو الإنجليزية (ضغط، Push-up...)', category: 'الفئة',
    allCategories: 'كل الفئات', equipment: 'المعدات', allEquipment: 'كل المعدات', muscleGroup: 'مجموعة العضلات',
    allMuscles: 'كل مجموعات العضلات', difficulty: 'المستوى', allDifficulties: 'كل المستويات', noExerciseResults: 'لا توجد تمارين تطابق عوامل التصفية هذه.',
    emptyExerciseLibrary: 'لا توجد تمارين منشورة بعد. استورد كتالوج تمارين موثوقاً لإضافتها إلى المكتبة.',
    loadingExercises: 'جارٍ تحميل التمارين…', exerciseLoadError: 'تعذر تحميل التمارين.', exercises: 'تمريناً',
    page: 'الصفحة', previous: 'السابق', next: 'التالي', demoVideo: 'مشاهدة العرض', videoUnavailable: 'الفيديو غير متاح',
    videoUnsupported: 'لا يستطيع هذا المتصفح تشغيل الفيديو.', close: 'إغلاق',
    category_strength: 'قوة', category_cardio: 'لياقة قلبية', category_mobility: 'حركة ومرونة', category_plyometrics: 'تمارين انفجارية', category_warmup: 'إحماء',
    equipment_barbell: 'بار', equipment_dumbbell: 'دمبل', equipment_kettlebell: 'كرة حديدية', equipment_cable: 'كابل',
    equipment_machine: 'جهاز', equipment_resistance_band: 'شريط مقاومة', equipment_bodyweight: 'وزن الجسم', equipment_medicine_ball: 'كرة طبية',
    equipment_bench: 'مقعد', equipment_smith_machine: 'جهاز سميث', equipment_trap_bar: 'بار سداسي', equipment_landmine: 'بار أرضي',
    equipment_plyometric_box: 'صندوق قفز', equipment_suspension_trainer: 'حبال تعليق', equipment_foam_roller: 'أسطوانة تدليك', equipment_exercise_ball: 'كرة تمرين', equipment_other: 'أخرى',
    muscle_chest: 'الصدر', muscle_back: 'الظهر', muscle_shoulders: 'الأكتاف', muscle_biceps: 'العضلة ذات الرأسين', muscle_triceps: 'العضلة ثلاثية الرؤوس', muscle_forearms: 'الساعدان',
    muscle_quadriceps: 'العضلة الرباعية', muscle_hamstrings: 'أوتار الركبة', muscle_glutes: 'الأرداف', muscle_calves: 'السمانة', muscle_core: 'الجذع', muscle_full_body: 'الجسم كاملاً',
    muscle_lower_back: 'أسفل الظهر', muscle_traps: 'العضلة شبه المنحرفة', muscle_neck: 'الرقبة', muscle_hip_flexors: 'مثنيات الورك', muscle_adductors: 'العضلات المقربة', muscle_abductors: 'العضلات المبعدة',
    difficulty_beginner: 'مبتدئ', difficulty_intermediate: 'متوسط', difficulty_advanced: 'متقدم',
    workoutBuilder: 'منشئ التمارين', workoutBuilderDescription: 'أنشئ البرامج التدريبية يدوياً واحفظها بترتيب التمارين ضمن أيام التدريب.',
    programDetails: 'تفاصيل البرنامج', editProgram: 'تعديل البرنامج', newProgram: 'برنامج جديد', startNewProgram: 'بدء برنامج جديد', days: 'أيام',
    savedPrograms: 'البرامج المحفوظة', selectProgram: 'اختر برنامجاً محفوظاً', loadProgram: 'تحميل البرنامج',
    loadingProgram: 'جارٍ التحميل…', loadProgramError: 'تعذر تحميل البرنامج.', programLoadError: 'تعذر تحميل البرامج المحفوظة.',
    programTitle: 'اسم البرنامج', programDescription: 'الوصف', programTitleRequired: 'أدخل اسم البرنامج.',
    day: 'اليوم', addDay: 'إضافة يوم', dayName: 'اسم يوم التدريب', moveUp: 'تحريك لأعلى', moveDown: 'تحريك لأسفل',
    removeDay: 'حذف اليوم', addExercise: 'إضافة', addExercises: 'إضافة تمارين', addExerciseHint: 'اختر تمارين من المكتبة لبناء هذا اليوم.',
    unavailableExercise: 'التمرين غير متاح', removeExercise: 'حذف التمرين', sets: 'المجموعات', reps: 'التكرارات',
    restSeconds: 'الراحة (ثوانٍ)', notes: 'ملاحظات', saveProgram: 'حفظ البرنامج', savingProgram: 'جارٍ الحفظ…',
    programSaved: 'تم حفظ البرنامج.', saveProgramError: 'تعذر حفظ البرنامج.',
  },
  de: {
    exerciseLibrary: 'Übungsbibliothek', exerciseLibraryDescription: 'Durchsuche und filtere den veröffentlichten Übungskatalog mit echten Demonstrationsvideos.',
    exerciseInstructions: 'Anleitung',
    searchExercises: 'Übungen suchen', searchExercisePlaceholder: 'Auf Deutsch oder Englisch suchen (Kniebeuge, squat...)', category: 'Kategorie',
    allCategories: 'Alle Kategorien', equipment: 'Ausrüstung', allEquipment: 'Alle Ausrüstung', muscleGroup: 'Muskelgruppe',
    allMuscles: 'Alle Muskelgruppen', difficulty: 'Schwierigkeit', allDifficulties: 'Alle Stufen', noExerciseResults: 'Keine Übungen entsprechen diesen Filtern.',
    emptyExerciseLibrary: 'Es sind noch keine Übungen veröffentlicht. Importiere einen geprüften Übungskatalog.',
    loadingExercises: 'Übungen werden geladen…', exerciseLoadError: 'Übungen konnten nicht geladen werden.', exercises: 'Übungen',
    page: 'Seite', previous: 'Zurück', next: 'Weiter', demoVideo: 'Video ansehen', videoUnavailable: 'Video nicht verfügbar',
    videoUnsupported: 'Dieser Browser kann das Video nicht abspielen.', close: 'Schließen',
    category_strength: 'Kraft', category_cardio: 'Cardio', category_mobility: 'Mobilität', category_plyometrics: 'Plyometrie', category_warmup: 'Aufwärmen',
    equipment_barbell: 'Langhantel', equipment_dumbbell: 'Kurzhantel', equipment_kettlebell: 'Kettlebell', equipment_cable: 'Kabelzug',
    equipment_machine: 'Maschine', equipment_resistance_band: 'Widerstandsband', equipment_bodyweight: 'Eigengewicht', equipment_medicine_ball: 'Medizinball',
    equipment_bench: 'Bank', equipment_smith_machine: 'Multipresse', equipment_trap_bar: 'Trap-Bar', equipment_landmine: 'Landmine',
    equipment_plyometric_box: 'Plyo-Box', equipment_suspension_trainer: 'Schlingentrainer', equipment_foam_roller: 'Faszienrolle', equipment_exercise_ball: 'Gymnastikball', equipment_other: 'Sonstiges',
    muscle_chest: 'Brust', muscle_back: 'Rücken', muscle_shoulders: 'Schultern', muscle_biceps: 'Bizeps', muscle_triceps: 'Trizeps', muscle_forearms: 'Unterarme',
    muscle_quadriceps: 'Quadrizeps', muscle_hamstrings: 'Beinbeuger', muscle_glutes: 'Gesäß', muscle_calves: 'Waden', muscle_core: 'Rumpf', muscle_full_body: 'Ganzkörper',
    muscle_lower_back: 'Unterer Rücken', muscle_traps: 'Trapezmuskel', muscle_neck: 'Nacken', muscle_hip_flexors: 'Hüftbeuger', muscle_adductors: 'Adduktoren', muscle_abductors: 'Abduktoren',
    difficulty_beginner: 'Anfänger', difficulty_intermediate: 'Mittel', difficulty_advanced: 'Fortgeschritten',
    workoutBuilder: 'Trainingsplan-Builder', workoutBuilderDescription: 'Erstelle und speichere Trainingspläne manuell, indem du echte Übungen auf Trainingstage verteilst.',
    programDetails: 'Programmdetails', editProgram: 'Programm bearbeiten', newProgram: 'Neues Programm', startNewProgram: 'Neues Programm beginnen', days: 'Tage',
    savedPrograms: 'Gespeicherte Programme', selectProgram: 'Gespeichertes Programm auswählen', loadProgram: 'Programm laden',
    loadingProgram: 'Wird geladen…', loadProgramError: 'Programm konnte nicht geladen werden.', programLoadError: 'Gespeicherte Programme konnten nicht geladen werden.',
    programTitle: 'Programmname', programDescription: 'Beschreibung', programTitleRequired: 'Gib einen Programmnamen ein.',
    day: 'Tag', addDay: 'Tag hinzufügen', dayName: 'Name des Trainingstags', moveUp: 'Nach oben', moveDown: 'Nach unten',
    removeDay: 'Tag entfernen', addExercise: 'Hinzufügen', addExercises: 'Übungen hinzufügen', addExerciseHint: 'Wähle Übungen aus der Bibliothek für diesen Trainingstag.',
    unavailableExercise: 'Übung nicht verfügbar', removeExercise: 'Übung entfernen', sets: 'Sätze', reps: 'Wiederholungen',
    restSeconds: 'Pause (Sekunden)', notes: 'Notizen', saveProgram: 'Programm speichern', savingProgram: 'Wird gespeichert…',
    programSaved: 'Programm gespeichert.', saveProgramError: 'Programm konnte nicht gespeichert werden.',
  },
  fr: {
    exerciseLibrary: 'Bibliothèque d’exercices', exerciseLibraryDescription: 'Recherchez et filtrez le catalogue publié, avec de vraies vidéos de démonstration.',
    exerciseInstructions: 'Instructions',
    searchExercises: 'Rechercher des exercices', searchExercisePlaceholder: 'Chercher en français ou en anglais (pompe, push-up...)', category: 'Catégorie',
    allCategories: 'Toutes les catégories', equipment: 'Équipement', allEquipment: 'Tout l’équipement', muscleGroup: 'Groupe musculaire',
    allMuscles: 'Tous les groupes musculaires', difficulty: 'Difficulté', allDifficulties: 'Tous les niveaux', noExerciseResults: 'Aucun exercice ne correspond à ces filtres.',
    emptyExerciseLibrary: 'Aucun exercice publié pour le moment. Importez un catalogue vérifié pour remplir la bibliothèque.',
    loadingExercises: 'Chargement des exercices…', exerciseLoadError: 'Impossible de charger les exercices.', exercises: 'exercices',
    page: 'Page', previous: 'Précédent', next: 'Suivant', demoVideo: 'Voir la démonstration', videoUnavailable: 'Vidéo indisponible',
    videoUnsupported: 'Ce navigateur ne peut pas lire cette vidéo.', close: 'Fermer',
    category_strength: 'Force', category_cardio: 'Cardio', category_mobility: 'Mobilité', category_plyometrics: 'Pliométrie', category_warmup: 'Échauffement',
    equipment_barbell: 'Barre', equipment_dumbbell: 'Haltère', equipment_kettlebell: 'Kettlebell', equipment_cable: 'Poulie',
    equipment_machine: 'Machine', equipment_resistance_band: 'Bande élastique', equipment_bodyweight: 'Poids du corps', equipment_medicine_ball: 'Medecine-ball',
    equipment_bench: 'Banc', equipment_smith_machine: 'Machine Smith', equipment_trap_bar: 'Barre hexagonale', equipment_landmine: 'Landmine',
    equipment_plyometric_box: 'Box de pliométrie', equipment_suspension_trainer: 'Sangles de suspension', equipment_foam_roller: 'Rouleau de massage', equipment_exercise_ball: 'Ballon de fitness', equipment_other: 'Autre',
    muscle_chest: 'Pectoraux', muscle_back: 'Dos', muscle_shoulders: 'Épaules', muscle_biceps: 'Biceps', muscle_triceps: 'Triceps', muscle_forearms: 'Avant-bras',
    muscle_quadriceps: 'Quadriceps', muscle_hamstrings: 'Ischio-jambiers', muscle_glutes: 'Fessiers', muscle_calves: 'Mollets', muscle_core: 'Centre du corps', muscle_full_body: 'Corps entier',
    muscle_lower_back: 'Bas du dos', muscle_traps: 'Trapèzes', muscle_neck: 'Cou', muscle_hip_flexors: 'Fléchisseurs de hanche', muscle_adductors: 'Adducteurs', muscle_abductors: 'Abducteurs',
    difficulty_beginner: 'Débutant', difficulty_intermediate: 'Intermédiaire', difficulty_advanced: 'Avancé',
    workoutBuilder: 'Créateur de programmes', workoutBuilderDescription: 'Créez et enregistrez manuellement des programmes en répartissant de vrais exercices par jour.',
    programDetails: 'Détails du programme', editProgram: 'Modifier le programme', newProgram: 'Nouveau programme', startNewProgram: 'Créer un nouveau programme', days: 'jours',
    savedPrograms: 'Programmes enregistrés', selectProgram: 'Choisir un programme enregistré', loadProgram: 'Charger le programme',
    loadingProgram: 'Chargement…', loadProgramError: 'Impossible de charger le programme.', programLoadError: 'Impossible de charger les programmes enregistrés.',
    programTitle: 'Nom du programme', programDescription: 'Description', programTitleRequired: 'Saisissez un nom de programme.',
    day: 'Jour', addDay: 'Ajouter un jour', dayName: 'Nom du jour d’entraînement', moveUp: 'Monter', moveDown: 'Descendre',
    removeDay: 'Supprimer le jour', addExercise: 'Ajouter', addExercises: 'Ajouter des exercices', addExerciseHint: 'Choisissez des exercices de la bibliothèque pour cette journée.',
    unavailableExercise: 'Exercice indisponible', removeExercise: 'Supprimer l’exercice', sets: 'Séries', reps: 'Répétitions',
    restSeconds: 'Repos (secondes)', notes: 'Notes', saveProgram: 'Enregistrer le programme', savingProgram: 'Enregistrement…',
    programSaved: 'Programme enregistré.', saveProgramError: 'Impossible d’enregistrer le programme.',
  },
  es: {
    exerciseLibrary: 'Biblioteca de ejercicios', exerciseLibraryDescription: 'Busca y filtra el catálogo publicado, con vídeos de demostración reales.',
    exerciseInstructions: 'Instrucciones',
    searchExercises: 'Buscar ejercicios', searchExercisePlaceholder: 'Buscar en español o inglés (sentadilla, squat...)', category: 'Categoría',
    allCategories: 'Todas las categorías', equipment: 'Equipamiento', allEquipment: 'Todo el equipamiento', muscleGroup: 'Grupo muscular',
    allMuscles: 'Todos los grupos musculares', difficulty: 'Dificultad', allDifficulties: 'Todos los niveles', noExerciseResults: 'Ningún ejercicio coincide con estos filtros.',
    emptyExerciseLibrary: 'Aún no hay ejercicios publicados. Importa un catálogo verificado para completar la biblioteca.',
    loadingExercises: 'Cargando ejercicios…', exerciseLoadError: 'No se pudieron cargar los ejercicios.', exercises: 'ejercicios',
    page: 'Página', previous: 'Anterior', next: 'Siguiente', demoVideo: 'Ver demostración', videoUnavailable: 'Vídeo no disponible',
    videoUnsupported: 'Este navegador no puede reproducir este vídeo.', close: 'Cerrar',
    category_strength: 'Fuerza', category_cardio: 'Cardio', category_mobility: 'Movilidad', category_plyometrics: 'Pliometría', category_warmup: 'Calentamiento',
    equipment_barbell: 'Barra', equipment_dumbbell: 'Mancuerna', equipment_kettlebell: 'Pesa rusa', equipment_cable: 'Polea',
    equipment_machine: 'Máquina', equipment_resistance_band: 'Banda elástica', equipment_bodyweight: 'Peso corporal', equipment_medicine_ball: 'Balón medicinal',
    equipment_bench: 'Banco', equipment_smith_machine: 'Máquina Smith', equipment_trap_bar: 'Barra hexagonal', equipment_landmine: 'Landmine',
    equipment_plyometric_box: 'Cajón pliométrico', equipment_suspension_trainer: 'Entrenador de suspensión', equipment_foam_roller: 'Rodillo de espuma', equipment_exercise_ball: 'Balón de ejercicio', equipment_other: 'Otro',
    muscle_chest: 'Pecho', muscle_back: 'Espalda', muscle_shoulders: 'Hombros', muscle_biceps: 'Bíceps', muscle_triceps: 'Tríceps', muscle_forearms: 'Antebrazos',
    muscle_quadriceps: 'Cuádriceps', muscle_hamstrings: 'Isquiotibiales', muscle_glutes: 'Glúteos', muscle_calves: 'Pantorrillas', muscle_core: 'Zona media', muscle_full_body: 'Cuerpo completo',
    muscle_lower_back: 'Zona lumbar', muscle_traps: 'Trapecios', muscle_neck: 'Cuello', muscle_hip_flexors: 'Flexores de cadera', muscle_adductors: 'Aductores', muscle_abductors: 'Abductores',
    difficulty_beginner: 'Principiante', difficulty_intermediate: 'Intermedio', difficulty_advanced: 'Avanzado',
    workoutBuilder: 'Creador de entrenamientos', workoutBuilderDescription: 'Crea y guarda programas manualmente organizando ejercicios reales por días de entrenamiento.',
    programDetails: 'Detalles del programa', editProgram: 'Editar programa', newProgram: 'Nuevo programa', startNewProgram: 'Crear un programa nuevo', days: 'días',
    savedPrograms: 'Programas guardados', selectProgram: 'Elige un programa guardado', loadProgram: 'Cargar programa',
    loadingProgram: 'Cargando…', loadProgramError: 'No se pudo cargar el programa.', programLoadError: 'No se pudieron cargar los programas guardados.',
    programTitle: 'Nombre del programa', programDescription: 'Descripción', programTitleRequired: 'Escribe un nombre para el programa.',
    day: 'Día', addDay: 'Añadir día', dayName: 'Nombre del día de entrenamiento', moveUp: 'Subir', moveDown: 'Bajar',
    removeDay: 'Eliminar día', addExercise: 'Añadir', addExercises: 'Añadir ejercicios', addExerciseHint: 'Elige ejercicios de la biblioteca para crear este día.',
    unavailableExercise: 'Ejercicio no disponible', removeExercise: 'Eliminar ejercicio', sets: 'Series', reps: 'Repeticiones',
    restSeconds: 'Descanso (segundos)', notes: 'Notas', saveProgram: 'Guardar programa', savingProgram: 'Guardando…',
    programSaved: 'Programa guardado.', saveProgramError: 'No se pudo guardar el programa.',
  },
};

for (const locale of supportedLocales) {
  Object.assign(translations[locale], workoutTranslations[locale]);
}

const clientTrackingTranslations = {
  en: {
    clientTrackingDescription: 'Log your workouts, track body measurements and private progress photos, and record daily habits.',
    clientAccountRequired: 'Sign in with a client account to use workout logging and progress tracking.',
    workoutLog: 'Workout log', progressTracking: 'Progress tracking', habitTracker: 'Habit tracker',
    newWorkout: 'Log a workout', workoutDate: 'Workout date', workoutName: 'Workout name',
    workoutNamePlaceholder: 'For example, Upper body', addAtLeastOneExercise: 'Add at least one exercise before saving.',
    actualReps: 'Actual reps', actualWeight: 'Actual weight (kg)', set: 'Set', repetitions: 'reps',
    addSet: 'Add set', saveWorkout: 'Save workout', savingWorkout: 'Saving workout…',
    workoutSaved: 'Workout saved.', saveWorkoutError: 'Could not save workout.', workoutHistory: 'Recent workouts',
    loadingWorkoutHistory: 'Loading workout history…', workoutHistoryLoadError: 'Could not load workout history.',
    noWorkoutHistory: 'No workouts logged yet.', bodyMetrics: 'Body measurements', measurementDate: 'Measurement date',
    weightKg: 'Weight (kg)', bodyFatPercentage: 'Body fat (%)', saveMeasurement: 'Save measurement',
    savingMeasurement: 'Saving…', measurementSaved: 'Measurement saved.', measurementSaveError: 'Could not save measurement.',
    measurementLoadError: 'Could not load measurements.', loadingProgress: 'Loading progress…',
    noMeasurements: 'No measurements recorded yet.', chartNeedEntries: 'Add at least two measurements to see a chart.',
    weightProgress: 'Weight trend', bodyFatProgress: 'Body-fat trend', progressPhotos: 'Progress photos',
    photoPrivacy: 'Photos are private to your account. Only you can view or delete them.',
    selectProgressPhoto: 'Choose a progress photo', uploadingPhoto: 'Uploading…',
    photoUploadError: 'Could not upload photo.', photoUploaded: 'Photo uploaded.',
    photoLoadError: 'Could not load photos.', noProgressPhotos: 'No progress photos uploaded yet.',
    progressPhotoAlt: 'Your private progress photo', deletePhoto: 'Delete photo', deletingPhoto: 'Deleting…',
    photoDeleted: 'Photo deleted.', photoDeleteError: 'Could not delete photo.',
    habitToday: 'Today', sleepHours: 'Sleep (hours)', waterLiters: 'Water (liters)', steps: 'Steps',
    saveHabits: 'Save today’s habits', savingHabits: 'Saving…', habitsSaved: 'Today’s habits saved.',
    habitSaveError: 'Could not save habits.', habitHistory: 'Last seven days',
    habitLoadError: 'Could not load habit history.', noHabitHistory: 'No habit entries for the last seven days.',
    markSetComplete: 'Mark set complete', removeSet: 'Remove set', workoutProgress: 'Workout progress', setsCompleted: 'sets completed', totalVolume: 'Total volume', noCompletedSets: 'Mark at least one set as complete before saving.', timeRange: 'Time range', range30: '30 days', range90: '90 days', rangeAll: 'All', latestValue: 'Latest', changeValue: 'Change', lowestValue: 'Lowest', highestValue: 'Highest', averageValue: 'Average', dailyGoal: 'Daily goal', goalsReached: 'goals reached',
    hours: 'hours', liters: 'L',
  },
  ar: {
    clientTrackingDescription: 'سجّل تمارينك وقياسات جسمك وصور التقدم الخاصة بك، وتابع عاداتك اليومية.',
    clientAccountRequired: 'سجّل الدخول بحساب عميل لاستخدام سجل التمارين وتتبع التقدم.',
    workoutLog: 'سجل التمارين', progressTracking: 'تتبع التقدم', habitTracker: 'متتبع العادات',
    newWorkout: 'تسجيل تمرين', workoutDate: 'تاريخ التمرين', workoutName: 'اسم التمرين',
    workoutNamePlaceholder: 'مثال: الجزء العلوي', addAtLeastOneExercise: 'أضف تمريناً واحداً على الأقل قبل الحفظ.',
    actualReps: 'التكرارات الفعلية', actualWeight: 'الوزن الفعلي (كجم)', set: 'مجموعة', repetitions: 'تكرار',
    addSet: 'إضافة مجموعة', saveWorkout: 'حفظ التمرين', savingWorkout: 'جارٍ حفظ التمرين…',
    workoutSaved: 'تم حفظ التمرين.', saveWorkoutError: 'تعذر حفظ التمرين.', workoutHistory: 'التمارين الأخيرة',
    loadingWorkoutHistory: 'جارٍ تحميل سجل التمارين…', workoutHistoryLoadError: 'تعذر تحميل سجل التمارين.',
    noWorkoutHistory: 'لم تسجل أي تمارين بعد.', bodyMetrics: 'قياسات الجسم', measurementDate: 'تاريخ القياس',
    weightKg: 'الوزن (كجم)', bodyFatPercentage: 'نسبة الدهون (%)', saveMeasurement: 'حفظ القياس',
    savingMeasurement: 'جارٍ الحفظ…', measurementSaved: 'تم حفظ القياس.', measurementSaveError: 'تعذر حفظ القياس.',
    measurementLoadError: 'تعذر تحميل القياسات.', loadingProgress: 'جارٍ تحميل التقدم…',
    noMeasurements: 'لم تسجل أي قياسات بعد.', chartNeedEntries: 'أضف قياسين على الأقل لعرض الرسم البياني.',
    weightProgress: 'تغير الوزن', bodyFatProgress: 'تغير نسبة الدهون', progressPhotos: 'صور التقدم',
    photoPrivacy: 'الصور خاصة بحسابك، ولا يمكن لأحد غيرك عرضها أو حذفها.',
    selectProgressPhoto: 'اختر صورة للتقدم', uploadingPhoto: 'جارٍ الرفع…',
    photoUploadError: 'تعذر رفع الصورة.', photoUploaded: 'تم رفع الصورة.',
    photoLoadError: 'تعذر تحميل الصور.', noProgressPhotos: 'لم ترفع صور تقدم بعد.',
    progressPhotoAlt: 'صورة تقدم خاصة بك', deletePhoto: 'حذف الصورة', deletingPhoto: 'جارٍ الحذف…',
    photoDeleted: 'تم حذف الصورة.', photoDeleteError: 'تعذر حذف الصورة.',
    habitToday: 'اليوم', sleepHours: 'النوم (ساعات)', waterLiters: 'الماء (لتر)', steps: 'الخطوات',
    saveHabits: 'حفظ عادات اليوم', savingHabits: 'جارٍ الحفظ…', habitsSaved: 'تم حفظ عادات اليوم.',
    habitSaveError: 'تعذر حفظ العادات.', habitHistory: 'آخر سبعة أيام',
    habitLoadError: 'تعذر تحميل سجل العادات.', noHabitHistory: 'لا توجد سجلات عادات في الأيام السبعة الماضية.',
    markSetComplete: 'تحديد المجموعة كمكتملة', removeSet: 'حذف المجموعة', workoutProgress: 'تقدم التمرين', setsCompleted: 'مجموعات مكتملة', totalVolume: 'إجمالي الحجم', noCompletedSets: 'حدد مجموعة واحدة على الأقل كمكتملة قبل الحفظ.', timeRange: 'النطاق الزمني', range30: '٣٠ يوماً', range90: '٩٠ يوماً', rangeAll: 'الكل', latestValue: 'الأحدث', changeValue: 'التغير', lowestValue: 'الأدنى', highestValue: 'الأعلى', averageValue: 'المتوسط', dailyGoal: 'الهدف اليومي', goalsReached: 'أهداف محققة',
    hours: 'ساعة', liters: 'لتر',
  },
  de: {
    clientTrackingDescription: 'Protokolliere Workouts, Körpermessungen und private Fortschrittsfotos sowie tägliche Gewohnheiten.',
    clientAccountRequired: 'Melde dich mit einem Kundenkonto an, um Training und Fortschritt zu protokollieren.',
    workoutLog: 'Workout-Protokoll', progressTracking: 'Fortschritt', habitTracker: 'Gewohnheiten',
    newWorkout: 'Workout protokollieren', workoutDate: 'Trainingsdatum', workoutName: 'Workoutname',
    workoutNamePlaceholder: 'Zum Beispiel Oberkörper', addAtLeastOneExercise: 'Füge vor dem Speichern mindestens eine Übung hinzu.',
    actualReps: 'Tatsächliche Wiederholungen', actualWeight: 'Tatsächliches Gewicht (kg)', set: 'Satz', repetitions: 'Wdh.',
    addSet: 'Satz hinzufügen', saveWorkout: 'Workout speichern', savingWorkout: 'Wird gespeichert…',
    workoutSaved: 'Workout gespeichert.', saveWorkoutError: 'Workout konnte nicht gespeichert werden.', workoutHistory: 'Letzte Workouts',
    loadingWorkoutHistory: 'Workout-Verlauf wird geladen…', workoutHistoryLoadError: 'Workout-Verlauf konnte nicht geladen werden.',
    noWorkoutHistory: 'Noch keine Workouts protokolliert.', bodyMetrics: 'Körpermessungen', measurementDate: 'Messdatum',
    weightKg: 'Gewicht (kg)', bodyFatPercentage: 'Körperfett (%)', saveMeasurement: 'Messung speichern',
    savingMeasurement: 'Wird gespeichert…', measurementSaved: 'Messung gespeichert.', measurementSaveError: 'Messung konnte nicht gespeichert werden.',
    measurementLoadError: 'Messungen konnten nicht geladen werden.', loadingProgress: 'Fortschritt wird geladen…',
    noMeasurements: 'Noch keine Messungen erfasst.', chartNeedEntries: 'Erfasse mindestens zwei Messungen für ein Diagramm.',
    weightProgress: 'Gewichtsverlauf', bodyFatProgress: 'Körperfettverlauf', progressPhotos: 'Fortschrittsfotos',
    photoPrivacy: 'Fotos sind privat in deinem Konto. Nur du kannst sie ansehen oder löschen.',
    selectProgressPhoto: 'Fortschrittsfoto auswählen', uploadingPhoto: 'Wird hochgeladen…',
    photoUploadError: 'Foto konnte nicht hochgeladen werden.', photoUploaded: 'Foto hochgeladen.',
    photoLoadError: 'Fotos konnten nicht geladen werden.', noProgressPhotos: 'Noch keine Fortschrittsfotos hochgeladen.',
    progressPhotoAlt: 'Dein privates Fortschrittsfoto', deletePhoto: 'Foto löschen', deletingPhoto: 'Wird gelöscht…',
    photoDeleted: 'Foto gelöscht.', photoDeleteError: 'Foto konnte nicht gelöscht werden.',
    habitToday: 'Heute', sleepHours: 'Schlaf (Stunden)', waterLiters: 'Wasser (Liter)', steps: 'Schritte',
    saveHabits: 'Heutige Gewohnheiten speichern', savingHabits: 'Wird gespeichert…', habitsSaved: 'Heutige Gewohnheiten gespeichert.',
    habitSaveError: 'Gewohnheiten konnten nicht gespeichert werden.', habitHistory: 'Letzte sieben Tage',
    habitLoadError: 'Gewohnheiten konnten nicht geladen werden.', noHabitHistory: 'Keine Einträge in den letzten sieben Tagen.',
    markSetComplete: 'Satz als erledigt markieren', removeSet: 'Satz entfernen', workoutProgress: 'Workout-Fortschritt', setsCompleted: 'Sätze erledigt', totalVolume: 'Gesamtvolumen', noCompletedSets: 'Markiere vor dem Speichern mindestens einen Satz als erledigt.', timeRange: 'Zeitraum', range30: '30 Tage', range90: '90 Tage', rangeAll: 'Alle', latestValue: 'Aktuell', changeValue: 'Änderung', lowestValue: 'Minimum', highestValue: 'Maximum', averageValue: 'Durchschnitt', dailyGoal: 'Tagesziel', goalsReached: 'Ziele erreicht',
    hours: 'Stunden', liters: 'L',
  },
  fr: {
    clientTrackingDescription: 'Consignez vos entraînements, mensurations et photos privées, ainsi que vos habitudes quotidiennes.',
    clientAccountRequired: 'Connectez-vous avec un compte client pour suivre vos entraînements et votre progression.',
    workoutLog: 'Journal d’entraînement', progressTracking: 'Suivi de progression', habitTracker: 'Suivi des habitudes',
    newWorkout: 'Consigner un entraînement', workoutDate: 'Date de l’entraînement', workoutName: 'Nom de l’entraînement',
    workoutNamePlaceholder: 'Par exemple, haut du corps', addAtLeastOneExercise: 'Ajoutez au moins un exercice avant l’enregistrement.',
    actualReps: 'Répétitions effectuées', actualWeight: 'Poids utilisé (kg)', set: 'Série', repetitions: 'rép.',
    addSet: 'Ajouter une série', saveWorkout: 'Enregistrer', savingWorkout: 'Enregistrement…',
    workoutSaved: 'Entraînement enregistré.', saveWorkoutError: 'Impossible d’enregistrer l’entraînement.', workoutHistory: 'Entraînements récents',
    loadingWorkoutHistory: 'Chargement de l’historique…', workoutHistoryLoadError: 'Impossible de charger l’historique.',
    noWorkoutHistory: 'Aucun entraînement consigné.', bodyMetrics: 'Mensurations', measurementDate: 'Date de mesure',
    weightKg: 'Poids (kg)', bodyFatPercentage: 'Masse grasse (%)', saveMeasurement: 'Enregistrer la mesure',
    savingMeasurement: 'Enregistrement…', measurementSaved: 'Mesure enregistrée.', measurementSaveError: 'Impossible d’enregistrer la mesure.',
    measurementLoadError: 'Impossible de charger les mesures.', loadingProgress: 'Chargement de la progression…',
    noMeasurements: 'Aucune mesure enregistrée.', chartNeedEntries: 'Ajoutez au moins deux mesures pour afficher un graphique.',
    weightProgress: 'Évolution du poids', bodyFatProgress: 'Évolution de la masse grasse', progressPhotos: 'Photos de progression',
    photoPrivacy: 'Vos photos sont privées. Vous seul pouvez les consulter ou les supprimer.',
    selectProgressPhoto: 'Choisir une photo', uploadingPhoto: 'Envoi…',
    photoUploadError: 'Impossible d’envoyer la photo.', photoUploaded: 'Photo envoyée.',
    photoLoadError: 'Impossible de charger les photos.', noProgressPhotos: 'Aucune photo de progression envoyée.',
    progressPhotoAlt: 'Votre photo privée de progression', deletePhoto: 'Supprimer la photo', deletingPhoto: 'Suppression…',
    photoDeleted: 'Photo supprimée.', photoDeleteError: 'Impossible de supprimer la photo.',
    habitToday: 'Aujourd’hui', sleepHours: 'Sommeil (heures)', waterLiters: 'Eau (litres)', steps: 'Pas',
    saveHabits: 'Enregistrer les habitudes du jour', savingHabits: 'Enregistrement…', habitsSaved: 'Habitudes du jour enregistrées.',
    habitSaveError: 'Impossible d’enregistrer les habitudes.', habitHistory: 'Sept derniers jours',
    habitLoadError: 'Impossible de charger les habitudes.', noHabitHistory: 'Aucune habitude enregistrée ces sept derniers jours.',
    markSetComplete: 'Marquer la série comme terminée', removeSet: 'Supprimer la série', workoutProgress: 'Progression de l’entraînement', setsCompleted: 'séries terminées', totalVolume: 'Volume total', noCompletedSets: 'Marquez au moins une série comme terminée avant d’enregistrer.', timeRange: 'Période', range30: '30 jours', range90: '90 jours', rangeAll: 'Tout', latestValue: 'Dernière', changeValue: 'Variation', lowestValue: 'Minimum', highestValue: 'Maximum', averageValue: 'Moyenne', dailyGoal: 'Objectif quotidien', goalsReached: 'objectifs atteints',
    hours: 'heures', liters: 'L',
  },
  es: {
    clientTrackingDescription: 'Registra tus entrenamientos, medidas y fotos privadas de progreso, además de tus hábitos diarios.',
    clientAccountRequired: 'Inicia sesión con una cuenta de cliente para registrar entrenamientos y progreso.',
    workoutLog: 'Registro de entrenamiento', progressTracking: 'Seguimiento del progreso', habitTracker: 'Seguimiento de hábitos',
    newWorkout: 'Registrar entrenamiento', workoutDate: 'Fecha del entrenamiento', workoutName: 'Nombre del entrenamiento',
    workoutNamePlaceholder: 'Por ejemplo, tren superior', addAtLeastOneExercise: 'Añade al menos un ejercicio antes de guardar.',
    actualReps: 'Repeticiones realizadas', actualWeight: 'Peso utilizado (kg)', set: 'Serie', repetitions: 'reps.',
    addSet: 'Añadir serie', saveWorkout: 'Guardar entrenamiento', savingWorkout: 'Guardando…',
    workoutSaved: 'Entrenamiento guardado.', saveWorkoutError: 'No se pudo guardar el entrenamiento.', workoutHistory: 'Entrenamientos recientes',
    loadingWorkoutHistory: 'Cargando historial…', workoutHistoryLoadError: 'No se pudo cargar el historial.',
    noWorkoutHistory: 'Aún no hay entrenamientos registrados.', bodyMetrics: 'Medidas corporales', measurementDate: 'Fecha de medición',
    weightKg: 'Peso (kg)', bodyFatPercentage: 'Grasa corporal (%)', saveMeasurement: 'Guardar medida',
    savingMeasurement: 'Guardando…', measurementSaved: 'Medida guardada.', measurementSaveError: 'No se pudo guardar la medida.',
    measurementLoadError: 'No se pudieron cargar las medidas.', loadingProgress: 'Cargando progreso…',
    noMeasurements: 'Aún no hay medidas registradas.', chartNeedEntries: 'Añade al menos dos medidas para ver un gráfico.',
    weightProgress: 'Evolución del peso', bodyFatProgress: 'Evolución de grasa corporal', progressPhotos: 'Fotos de progreso',
    photoPrivacy: 'Tus fotos son privadas. Solo tú puedes verlas o eliminarlas.',
    selectProgressPhoto: 'Elegir foto de progreso', uploadingPhoto: 'Subiendo…',
    photoUploadError: 'No se pudo subir la foto.', photoUploaded: 'Foto subida.',
    photoLoadError: 'No se pudieron cargar las fotos.', noProgressPhotos: 'Aún no has subido fotos de progreso.',
    progressPhotoAlt: 'Tu foto privada de progreso', deletePhoto: 'Eliminar foto', deletingPhoto: 'Eliminando…',
    photoDeleted: 'Foto eliminada.', photoDeleteError: 'No se pudo eliminar la foto.',
    habitToday: 'Hoy', sleepHours: 'Sueño (horas)', waterLiters: 'Agua (litros)', steps: 'Pasos',
    saveHabits: 'Guardar hábitos de hoy', savingHabits: 'Guardando…', habitsSaved: 'Hábitos de hoy guardados.',
    habitSaveError: 'No se pudieron guardar los hábitos.', habitHistory: 'Últimos siete días',
    habitLoadError: 'No se pudo cargar el historial de hábitos.', noHabitHistory: 'No hay registros de hábitos en los últimos siete días.',
    markSetComplete: 'Marcar serie como completada', removeSet: 'Eliminar serie', workoutProgress: 'Progreso del entrenamiento', setsCompleted: 'series completadas', totalVolume: 'Volumen total', noCompletedSets: 'Marca al menos una serie como completada antes de guardar.', timeRange: 'Periodo', range30: '30 días', range90: '90 días', rangeAll: 'Todo', latestValue: 'Último', changeValue: 'Cambio', lowestValue: 'Mínimo', highestValue: 'Máximo', averageValue: 'Promedio', dailyGoal: 'Objetivo diario', goalsReached: 'objetivos logrados',
    hours: 'horas', liters: 'L',
  },
};

for (const locale of supportedLocales) {
  Object.assign(translations[locale], clientTrackingTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], priority2Translations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], businessTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], communityTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], platformTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], workflowTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], jackTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], engagementTranslations[locale], jackEngagementTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], growthTranslations[locale], jackGrowthTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], liveRoomTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], healthTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], chatTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], aiTranslations[locale]);
}

for (const locale of supportedLocales) {
  Object.assign(translations[locale], checklistTranslations[locale]);
  Object.assign(translations[locale], launchTranslations[locale]);
  Object.assign(translations[locale], billingTranslations[locale]);
  Object.assign(translations[locale], paymentsTranslations[locale]);
  Object.assign(translations[locale], publicPagesTranslations[locale]);
  Object.assign(translations[locale], campaignTranslations[locale]);
  Object.assign(translations[locale], uxTranslations[locale]);
  Object.assign(translations[locale], dashboardTranslations[locale]);
  Object.assign(translations[locale], habitsTranslations[locale]);
  Object.assign(translations[locale], checkinTranslations[locale]);
  Object.assign(translations[locale], mealPlanTranslations[locale]);
  Object.assign(translations[locale], progressionTranslations[locale]);
  Object.assign(translations[locale], jackAssistantTranslations[locale]);
  Object.assign(translations[locale], exerciseVideoTranslations[locale]);
  Object.assign(translations[locale], customExerciseTranslations[locale]);
  Object.assign(translations[locale], tempoTranslations[locale]);
  Object.assign(translations[locale], calorieTranslations[locale]);
  Object.assign(translations[locale], ramadanTranslations[locale]);
  Object.assign(translations[locale], clientTagTranslations[locale]);
  Object.assign(translations[locale], teamErrorTranslations[locale]);
}
