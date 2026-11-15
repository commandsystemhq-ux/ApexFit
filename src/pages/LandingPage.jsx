import BrandMark from '../components/BrandMark.jsx';
import Button from '../components/Button.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function LandingPage({ onNavigate, onSignIn }) {
  const { t } = useLocale();

  return (
    <div className="landing">
      <header className="landing-nav">
        <button className="landing-brand" onClick={() => onNavigate('home')} aria-label={`ApexFit ${t('home')}`}><BrandMark /></button>
        <nav className="landing-links" aria-label={t('landingPlatform')}>
          <a href="#features">{t('landingPlatform')}</a><a href="#pricing">{t('landingPricing')}</a>
        </nav>
        <div className="landing-actions">
          <LanguageToggle />
          <Button variant="secondary" size="small" onClick={() => onSignIn('client')}>{t('clientSignIn')}</Button>
          <Button variant="primary" size="small" onClick={() => onSignIn('coach')}>{t('coachSignIn')}</Button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-orb hero-orb-one" /><div className="hero-orb hero-orb-two" />
        <div className="hero-content">
          <div className="pill"><span className="status-dot" /> {t('landingPill')}</div>
          <h1>{t('landingHeadlineOne')}<br /><span className="gradient-text">{t('landingHeadlineTwo')}</span></h1>
          <p>{t('landingDescription')}</p>
          <div className="hero-actions">
            <Button variant="primary" size="large" onClick={() => onSignIn('coach')}>{t('trial')} <span aria-hidden="true">→</span></Button>
            <Button variant="secondary" size="large" onClick={() => onSignIn('client')}>{t('clientSignIn')}</Button>
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
          <Button variant="primary" size="large" onClick={() => onSignIn('coach')}>{t('trial')} <span aria-hidden="true">→</span></Button>
        </article>
      </section>
      <footer className="landing-footer"><BrandMark /><span>© {new Date().getFullYear()} ApexFit</span></footer>
    </div>
  );
}
