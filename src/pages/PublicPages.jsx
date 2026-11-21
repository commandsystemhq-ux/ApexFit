import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PUBLIC_CONTENT_UPDATED, publicContentFor } from '../i18n/publicPagesContent.js';
import { AUTH_PATHS, PAGES } from '../routes.js';

function PublicLayout({ content, children }) {
  const { t } = useLocale();
  return (
    <div className="auth-page public-page">
      <header className="auth-header">
        <Link className="landing-brand" to={AUTH_PATHS.home} aria-label={`ApexFit ${t('home')}`}><BrandMark /></Link>
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
  const content = publicContentFor(locale);
  const page = content.pricing;
  const isCoach = profile?.role === 'coach';

  return (
    <PublicLayout content={content}>
      <article className="public-article">
        <header className="public-heading"><h1>{page.title}</h1><p>{page.intro}</p></header>
        <section className="pricing-card public-plan" aria-label={page.planName}>
          <span className="pricing-tag">{page.planName}</span>
          <div className="price"><strong>{page.price}</strong><span>{page.period}</span></div>
          <p>{page.trial}</p>
          <div className="public-plan-actions">
            {isCoach && <Link className="button button-primary button-large" to={PAGES.billing.path}>{t('pricingPageManage')}</Link>}
            {!profile && <>
              <Link className="button button-primary button-large" to={AUTH_PATHS.signup}>{page.signup} <span aria-hidden="true">→</span></Link>
              <Link className="button button-secondary button-large" to={AUTH_PATHS.login}>{page.login}</Link>
            </>}
          </div>
        </section>
        <section className="public-section">
          <h2>{page.featuresHeading}</h2>
          <div className="public-feature-grid">
            {page.features.map(([title, text]) => <div className="public-feature" key={title}><h3>{title}</h3><p>{text}</p></div>)}
          </div>
          <p className="public-note">{page.note}</p>
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
