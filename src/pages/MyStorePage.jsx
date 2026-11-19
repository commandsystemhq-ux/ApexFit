import { useCallback, useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import PaymentInstructions from '../components/PaymentInstructions.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { buyProduct, cancelStoreOrder, getMyStore, reportStorePayment } from '../services/storeService.js';
import { formatPrice, isSecureUrl, orderReference } from '../services/storeUtils.js';

export default function MyStorePage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const [store, setStore] = useState({ products: [], purchases: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const refresh = useCallback(async () => {
    setStore(await getMyStore());
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  // A paid product becomes an open order; the card then shows how to pay the coach.
  async function buy(product) {
    setBusyId(product.id);
    try {
      const result = await buyProduct(product.id);
      if (result.completed) showToast(t(result.alreadyOwned ? 'strOwned' : 'strPurchased'));
      else showToast(t('strOrderOpened'));
      await refresh();
    } catch (buyError) {
      showToast(`${t('strBuyError')} ${buyError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function reportPaid(product) {
    setBusyId(product.id);
    try {
      await reportStorePayment(product.pending_order.id);
      showToast(t('strPaymentReported'));
      await refresh();
    } catch (reportError) {
      showToast(`${t('payReportError')} ${reportError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function cancelOrder(product) {
    setBusyId(product.id);
    try {
      await cancelStoreOrder(product.pending_order.id);
      await refresh();
    } catch (cancelError) {
      showToast(`${t('strBuyError')} ${cancelError.message}`);
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
            {!product.owned && !product.pending_order && (
              <div className="template-actions">
                <Button variant="primary" size="small" disabled={busyId === product.id} onClick={() => buy(product)}>
                  {busyId === product.id ? t('strBuying') : product.price_cents === 0 ? t('strGet') : t('strBuy')}
                </Button>
              </div>
            )}
            {!product.owned && product.pending_order && (
              <div className="store-order">
                <span className="soft-badge badge-amber">{t(product.pending_order.reported ? 'invoice_waiting' : 'strAwaitingPayment')}</span>
                <PaymentInstructions coachId={product.coach_id} invoiceNumber={orderReference(product.pending_order.id)} />
                {product.pending_order.reported
                  ? <div className="notice notice-info" role="status">{t('strWaitingConfirm')}</div>
                  : <Button variant="primary" size="small" disabled={busyId === product.id} onClick={() => reportPaid(product)}>{t('payIPaid')}</Button>}
                <button className="text-action" type="button" disabled={busyId === product.id} onClick={() => cancelOrder(product)}>{t('strCancelOrder')}</button>
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
