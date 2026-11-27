import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BrandMark from '../components/BrandMark.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import PublicFooter from '../components/PublicFooter.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getPublicStore } from '../services/storeService.js';
import { formatPrice, isSecureUrl, isUuid } from '../services/storeUtils.js';
import { AUTH_PATHS, PAGES } from '../routes.js';

// A coach's shop window: anyone can browse the published programs; buying needs a client account of that coach.
export default function PublicStorePage() {
  const { t, locale } = useLocale();
  const { coachId } = useParams();
  const { profile } = useAuth();
  const [state, setState] = useState({ status: 'loading', store: null });

  useEffect(() => {
    if (!isUuid(coachId)) {
      setState({ status: 'missing', store: null });
      return undefined;
    }
    let active = true;
    getPublicStore(coachId)
      .then((store) => {
        if (active) setState(store ? { status: 'ready', store } : { status: 'missing', store: null });
      })
      .catch(() => {
        if (active) setState({ status: 'missing', store: null });
      });
    return () => { active = false; };
  }, [coachId]);

  const isClient = profile?.role === 'client';
  const { store } = state;

  return (
    <div className="auth-page">
      <header className="auth-header">
        <Link className="landing-brand" to={AUTH_PATHS.home} aria-label={`ApexFit ${t('home')}`}><BrandMark /></Link>
        <ThemeToggle compact />
        <LanguageToggle />
      </header>
      <main className="public-store">
        {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {state.status === 'missing' && <section className="panel"><div className="dashboard-empty"><h3>{t('strPublicNotFound')}</h3></div></section>}

        {state.status === 'ready' && (
          <>
            <div className="public-store-heading">
              <h1>{t('strPublicTitle')} {store.coach_name}</h1>
              <p>{t('strPublicHelp')}</p>
              <Link className="button button-primary" to={isClient ? PAGES.myStore.path : AUTH_PATHS.login}>{isClient ? t('strPublicOpen') : t('strPublicLogin')}</Link>
            </div>
            {store.products.length === 0 && <section className="panel"><div className="dashboard-empty"><p>{t('strPublicEmpty')}</p></div></section>}
            <div className="store-grid">
              {store.products.map((product) => (
                <article className="panel store-card" key={product.id}>
                  {isSecureUrl(product.cover_image_url) && <img className="store-cover" src={product.cover_image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                  <h3 dir="auto">{product.title}</h3>
                  {product.description && <p className="muted-copy" dir="auto">{product.description}</p>}
                  <strong className="store-price" dir="ltr">{formatPrice(product.price_cents, product.currency, locale, t('strFree'))}</strong>
                </article>
              ))}
            </div>
          </>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
