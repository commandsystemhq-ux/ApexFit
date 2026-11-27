import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function LandingPage() {
  const { t } = useLocale();

  return (
    <div className="landing">
      <header className="landing-nav">
        <Link className="landing-brand" to="/" aria-label={`ApexFit ${t('home')}`}><BrandMark /></Link>
        <nav className="landing-links" aria-label={t('landingPlatform')}>
          <a href="#features">{t('landingPlatform')}</a><a href="#pricing">{t('landingPricing')}</a>
        </nav>
        <div className="landing-actions">
          <ThemeToggle compact />
          <LanguageToggle />
          <Link className="button button-secondary button-small" to="/login">{t('loginLink')}</Link>
          <Link className="button button-primary button-small" to="/signup">{t('signupLink')}</Link>
        </div>
      </header>

      <section className="hero">
        <div className="hero-orb hero-orb-one" /><div className="hero-orb hero-orb-two" />
        <div className="hero-content">
          <div className="pill"><span className="status-dot" /> {t('landingPill')}</div>
          <h1>{t('landingHeadlineOne')}<br /><span className="gradient-text">{t('landingHeadlineTwo')}</span></h1>
          <p>{t('landingDescription')}</p>
          <div className="hero-actions">
            <Link className="button button-primary button-large" to="/signup">{t('trial')} <span aria-hidden="true">→</span></Link>
            <Link className="button button-secondary button-large" to="/login">{t('loginLink')}</Link>
          </div>
        </div>
        <div className="hero-brand-art">
          <div className="hero-brand-glow" />
          <BrandMark />
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="section-heading"><span className="eyebrow">{t('landingPlatform')}</span><h2>{t('landingFeatureHeading')}</h2></div>
        <div className="feature-grid">
          {[['✦', 'featurePlans', 'featurePlansText'], ['◉', 'featureClients', 'featureClientsText'], ['↗', 'featureGrowth', 'featureGrowthText']].map(([icon, title, text], index) => (
            <article className="feature-card" key={title}>
              <span className={`feature-icon feature-icon-${index}`}>{icon}</span>
              <h3>{t(title)}</h3><p>{t(text)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="pricing-copy"><span className="eyebrow">{t('landingPricing')}</span><h2>{t('pricingHeading')}</h2><p>{t('pricingDescription')}</p></div>
        <article className="pricing-card">
          <span className="pricing-tag">{t('pricingDetails')}</span>
          <div className="price"><strong>$39</strong><span>/ {t('month')}</span></div>
          <ul><li>{t('pricingFeature1')}</li><li>{t('pricingFeature2')}</li><li>{t('pricingFeature3')}</li></ul>
          <Link className="button button-primary button-large" to="/signup">{t('trial')} <span aria-hidden="true">→</span></Link>
        </article>
      </section>
      <PublicFooter />
    </div>
  );
}
