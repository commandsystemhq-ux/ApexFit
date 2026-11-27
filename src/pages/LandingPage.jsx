import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import BrandMark from '../components/BrandMark.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import AppPreview from '../components/marketing/AppPreview.jsx';
import ComparisonTable from '../components/marketing/ComparisonTable.jsx';
import Faq from '../components/marketing/Faq.jsx';
import FeatureShowcase from '../components/marketing/FeatureShowcase.jsx';
import PlanCard from '../components/marketing/PlanCard.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { usePricing } from '../hooks/usePricing.js';
import { AUTH_PATHS } from '../routes.js';

const STATS = [['1,204+', 'mkStatFoods'], ['876+', 'mkStatExercises'], ['5', 'mkStatLanguages'], ['14', 'mkStatTrial']];
const NAV = [['features', 'mkNavFeatures'], ['pricing', 'mkNavPricing'], ['compare', 'mkNavCompare'], ['faq', 'mkNavFaq']];
const PAIRS = [1, 2, 3, 4, 5];
const STEPS = [1, 2, 3];
const AUDIENCES = [1, 2, 3, 4];

function SectionHeading({ eyebrow, title, text }) {
  return (
    <div className="mk-heading">
      {eyebrow && <span className="mk-eyebrow">{eyebrow}</span>}
      <h2>{title}</h2>
      {text && <p>{text}</p>}
    </div>
  );
}

export default function LandingPage() {
  const { t } = useLocale();
  const { hash } = useLocation();
  const { pricing } = usePricing();

  // Footer and menu links point to /#section, also from the other public pages.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  const trialButton = (
    <Link className="button button-primary button-large" to={AUTH_PATHS.signup}>{t('mkCtaTrial')} <span className="mk-arrow" aria-hidden="true">{'\u2192'}</span></Link>
  );

  return (
    <div className="landing mk-landing">
      <header className="landing-nav">
        <Link className="landing-brand" to="/" aria-label={`ApexFit ${t('home')}`}><BrandMark /></Link>
        <nav className="landing-links mk-nav-links" aria-label={t('mkNavLabel')}>
          {NAV.map(([id, key]) => <a key={id} href={`#${id}`}>{t(key)}</a>)}
        </nav>
        <div className="landing-actions">
          <ThemeToggle compact />
          <LanguageToggle />
          <Link className="button button-secondary button-small" to={AUTH_PATHS.login}>{t('loginLink')}</Link>
          <Link className="button button-primary button-small" to={AUTH_PATHS.signup}>{t('signupLink')}</Link>
        </div>
      </header>

      <main>
        <section className="mk-hero">
          <div className="hero-orb hero-orb-one" aria-hidden="true" /><div className="hero-orb hero-orb-two" aria-hidden="true" />
          <div className="mk-hero-copy">
            <div className="mk-badge"><span className="status-dot" aria-hidden="true" /> {t('mkBadge')}</div>
            <h1>{t('mkHeroA')} <span className="mk-gradient">{t('mkHeroB')}</span></h1>
            <p>{t('mkHeroSub')}</p>
            <div className="mk-hero-actions">
              {trialButton}
              <a className="button button-secondary button-large" href="#features">{t('mkCtaFeatures')}</a>
            </div>
            <small className="mk-hero-note">{t('mkHeroNote')}</small>
          </div>
          <AppPreview />
        </section>

        <section className="mk-stats" aria-label="ApexFit">
          {STATS.map(([value, key]) => (
            <div key={key}><strong className="mk-gradient" dir="ltr">{value}</strong><span>{t(key)}</span></div>
          ))}
        </section>

        <section className="mk-section" id="why">
          <SectionHeading eyebrow={t('mkProblemEyebrow')} title={t('mkProblemTitle')} text={t('mkProblemSub')} />
          <div className="mk-versus">
            <div className="mk-versus-card mk-versus-before">
              <h3>{t('mkBeforeTitle')}</h3>
              <ul>{PAIRS.map((id) => <li key={id}>{t(`mkBefore${id}`)}</li>)}</ul>
            </div>
            <div className="mk-versus-card mk-versus-after">
              <h3>{t('mkAfterTitle')}</h3>
              <ul>{PAIRS.map((id) => <li key={id}>{t(`mkAfter${id}`)}</li>)}</ul>
            </div>
          </div>
        </section>

        <section className="mk-section" id="features">
          <SectionHeading eyebrow={t('mkShowEyebrow')} title={t('mkShowTitle')} />
          <FeatureShowcase />
        </section>

        <section className="mk-section">
          <SectionHeading eyebrow={t('mkStepsEyebrow')} title={t('mkStepsTitle')} />
          <ol className="mk-steps">
            {STEPS.map((id) => (
              <li key={id}><span className="mk-step-number" aria-hidden="true">{id}</span><h3>{t(`mkStep${id}Title`)}</h3><p>{t(`mkStep${id}Text`)}</p></li>
            ))}
          </ol>
        </section>

        <section className="mk-section mk-section-tight">
          <SectionHeading title={t('mkWhoTitle')} />
          <div className="mk-who">
            {AUDIENCES.map((id) => <div className="mk-who-card" key={id}><h3>{t(`mkWho${id}Title`)}</h3><p>{t(`mkWho${id}Text`)}</p></div>)}
          </div>
        </section>

        <section className="mk-section" id="pricing">
          <SectionHeading eyebrow={t('mkPriceEyebrow')} title={t('mkPriceTitle')} text={t('mkPriceSub')} />
          <PlanCard pricing={pricing}>{trialButton}</PlanCard>
        </section>

        <section className="mk-section mk-section-tight" id="compare">
          <SectionHeading eyebrow={t('mkCmpEyebrow')} title={t('mkCmpTitle')} text={t('mkCmpSub')} />
          <ComparisonTable />
        </section>

        <section className="mk-section mk-section-narrow" id="faq">
          <SectionHeading eyebrow={t('mkFaqEyebrow')} title={t('mkFaqTitle')} />
          <Faq />
        </section>

        <section className="mk-final">
          <h2>{t('mkFinalTitle')}</h2>
          <p>{t('mkFinalText')}</p>
          {trialButton}
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
