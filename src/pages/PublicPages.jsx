import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import ComparisonTable from '../components/marketing/ComparisonTable.jsx';
import PlanCard from '../components/marketing/PlanCard.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { usePricing } from '../hooks/usePricing.js';
import { PUBLIC_CONTENT_UPDATED, publicContentFor } from '../i18n/publicPagesContent.js';
import { AUTH_PATHS, PAGES } from '../routes.js';

function PublicLayout({ content, children }) {
  const { t } = useLocale();
  return (
    <div className="auth-page public-page">
      <header className="auth-header">
        <Link className="landing-brand" to={AUTH_PATHS.home} aria-label={`ApexFit ${t('home')}`}><BrandMark /></Link>
        <ThemeToggle compact />
        <LanguageToggle />
      </header>
      {/* Pages without a translation for the chosen language are shown in English, with the matching language and direction. */}
      <main className="public-main" lang={content.locale} dir={content.locale === 'ar' ? 'rtl' : 'ltr'}>{children}</main>
      <PublicFooter />
    </div>
  );
}

export function PricingPage() {
  const { locale, t } = useLocale();
  const { profile } = useAuth();
  const { pricing } = usePricing();
  const isCoach = profile?.role === 'coach';

  return (
    <PublicLayout content={{ locale }}>
      <article className="mk-pricing-page">
        <header className="mk-heading">
          <h1>{t('mkPricingPageTitle')}</h1>
          <p>{t('mkPricingPageIntro')}</p>
        </header>
        <PlanCard pricing={pricing}>
          {isCoach && <Link className="button button-primary button-large" to={PAGES.billing.path}>{t('pricingPageManage')}</Link>}
          {!profile && <>
            <Link className="button button-primary button-large" to={AUTH_PATHS.signup}>{t('mkCtaTrial')} <span className="mk-arrow" aria-hidden="true">{'\u2192'}</span></Link>
            <Link className="button button-secondary button-large" to={AUTH_PATHS.login}>{t('loginLink')}</Link>
          </>}
        </PlanCard>
        <section className="mk-pricing-compare" aria-labelledby="mk-cmp-title">
          <div className="mk-heading"><h2 id="mk-cmp-title">{t('mkCmpTitle')}</h2><p>{t('mkCmpSub')}</p></div>
          <ComparisonTable />
        </section>
      </article>
    </PublicLayout>
  );
}
function LegalPage({ pageKey }) {
  const { locale, t } = useLocale();
  const content = publicContentFor(locale);
  const page = content[pageKey];

  return (
    <PublicLayout content={content}>
      <article className="public-article">
        <header className="public-heading">
          <h1>{page.title}</h1>
          <p>{page.intro}</p>
          <small>{t('publicUpdated')}: {PUBLIC_CONTENT_UPDATED}</small>
        </header>
        {page.sections.map(([heading, paragraphs]) => (
          <section className="public-section" key={heading}>
            <h2>{heading}</h2>
            {paragraphs.map((text) => <p key={text}>{text}</p>)}
          </section>
        ))}
        <Link className="button button-secondary" to={AUTH_PATHS.home}>{t('publicBackHome')}</Link>
      </article>
    </PublicLayout>
  );
}

export const TermsPage = () => <LegalPage pageKey="terms" />;
export const PrivacyPage = () => <LegalPage pageKey="privacy" />;
export const RefundsPage = () => <LegalPage pageKey="refunds" />;
