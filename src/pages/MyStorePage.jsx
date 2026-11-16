import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { buyProduct, getMyStore } from '../services/storeService.js';
import { formatPrice, isSecureUrl } from '../services/storeUtils.js';

export default function MyStorePage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [store, setStore] = useState({ products: [], purchases: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const handledReturn = useRef(false);

  const refresh = useCallback(async () => {
    setStore(await getMyStore());
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  // Coming back from Stripe Checkout: say what happened once, then clean the address.
  useEffect(() => {
    const result = searchParams.get('checkout');
    if (!result || handledReturn.current) return;
    handledReturn.current = true;
    showToast(t(result === 'success' ? 'strCheckoutSuccess' : 'strCheckoutCanceled'));
    setSearchParams({}, { replace: true });
    if (result === 'success') {
      // The webhook may take a moment; look again a few times.
      [2000, 6000, 12000].forEach((delay) => window.setTimeout(() => refresh().catch(() => {}), delay));
    }
  }, [searchParams, setSearchParams, showToast, t, refresh]);

  async function buy(product) {
    setBusyId(product.id);
    try {
      const result = await buyProduct(product.id);
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      showToast(t(result.alreadyOwned ? 'strOwned' : 'strPurchased'));
      await refresh();
    } catch (buyError) {
      showToast(`${t('strBuyError')} ${buyError.message}`);
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('strMyTitle')} description={t('strMyDescription')} />
      {error && <div className="notice notice-error" role="alert">{t('strMyLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}

      {!loading && !error && store.products.length === 0 && (
        <section className="panel"><div className="dashboard-empty"><h3>{t('strMyEmpty')}</h3><p>{t('strMyEmptyHelp')}</p></div></section>
      )}

      <div className="store-grid">
        {store.products.map((product) => (
          <article className="panel store-card" key={product.id}>
            {isSecureUrl(product.cover_image_url) && <img className="store-cover" src={product.cover_image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
            <div className="template-card-heading">
              <h3>{product.title}</h3>
              {product.owned && <span className="soft-badge badge-green">{t('strOwned')} ✅</span>}
            </div>
            {product.description && <p className="muted-copy" dir="auto">{product.description}</p>}
            <div className="template-meta">
              <strong className="store-price" dir="ltr">{formatPrice(product.price_cents, product.currency, locale, t('strFree'))}</strong>
              {product.coach_name && <span>{product.coach_name}</span>}
            </div>
            {!product.owned && (
              <div className="template-actions">
                <Button variant="primary" size="small" disabled={busyId === product.id} onClick={() => buy(product)}>
                  {busyId === product.id ? t('strBuying') : product.price_cents === 0 ? t('strGet') : t('strBuy')}
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('navMyStore')}</span><h3>{t('strLibrary')}</h3></div></div>
        {store.purchases.length === 0 && <p className="muted-copy">{t('strLibraryEmpty')}</p>}
        <div className="contract-list">
          {store.purchases.map((purchase) => (
            <article className="group-card" key={purchase.order_id}>
              <div className="template-card-heading">
                <h3>{purchase.title}</h3>
                <small className="muted-copy">{t('strBoughtOn')} {new Date(purchase.purchased_at).toLocaleDateString(locale)}</small>
              </div>
              {purchase.program && (
                <ol className="group-program-days">
                  {purchase.program.days.map((day, index) => (
                    <li key={`${day.name}-${index}`}>
                      <strong>{day.name}</strong>
                      <ul>
                        {day.exercises.map((exercise, exerciseIndex) => (
                          <li key={`${exercise.name}-${exerciseIndex}`}><span>{exercise.name}</span><small dir="ltr">{exercise.sets} × {exercise.reps}</small></li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
