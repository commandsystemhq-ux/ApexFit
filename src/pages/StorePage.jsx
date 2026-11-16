import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { CURRENCIES } from '../services/coachingUtils.js';
import { deleteProduct, getSales, listProducts, saveProduct, setProductPublished } from '../services/storeService.js';
import {
  STORE_LIMITS,
  centsToInput,
  emptyProductDraft,
  formatPrice,
  formatRevenue,
  isSecureUrl,
  publicStorePath,
  validateProductForm,
} from '../services/storeUtils.js';
import { listMyWorkoutPrograms } from '../services/workoutProgramService.js';

function ProductForm({ initial, programs, saving, onSave, onCancel }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateProductForm(draft).errors : {};
  const set = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;

  function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    const result = validateProductForm(draft);
    if (result.valid) onSave(result.payload);
  }

  return (
    <form className="panel store-form" onSubmit={handleSubmit} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('navStore')}</span><h3>{draft.id ? t('strEditHeading') : t('strNewHeading')}</h3></div></div>
      {programs.length === 0 && <div className="notice notice-info">{t('strNoPrograms')}</div>}

      <label className="form-label">
        <span>{t('strFieldProgram')}</span>
        <select className="field" value={draft.programId} onChange={set('programId')} aria-invalid={Boolean(errors.programId)}>
          <option value="">{t('strChooseProgram')}</option>
          {programs.map((program) => <option key={program.id} value={program.id}>{program.title}</option>)}
        </select>
        {fieldError(errors.programId)}
      </label>
      <label className="form-label">
        <span>{t('strFieldTitle')}</span>
        <input className="field" value={draft.title} maxLength={STORE_LIMITS.title + 20} onChange={set('title')} aria-invalid={Boolean(errors.title)} />
        {fieldError(errors.title)}
      </label>
      <label className="form-label">
        <span>{t('strFieldDescription')}</span>
        <textarea className="field" rows={3} value={draft.description} onChange={set('description')} />
        {fieldError(errors.description)}
      </label>
      <div className="wf-form-grid">
        <label className="form-label">
          <span>{t('strFieldPrice')}</span>
          <input className="field" inputMode="decimal" dir="ltr" value={draft.price} onChange={set('price')} aria-invalid={Boolean(errors.price)} />
          <small className="muted-copy">{t('strPriceHelp')}</small>
          {fieldError(errors.price)}
        </label>
        <label className="form-label">
          <span>{t('strFieldCurrency')}</span>
          <select className="field" value={draft.currency} onChange={set('currency')}>
            {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency.toUpperCase()}</option>)}
          </select>
          {fieldError(errors.currency)}
        </label>
      </div>
      <label className="form-label">
        <span>{t('strFieldCover')}</span>
        <input className="field" dir="ltr" value={draft.cover} placeholder="https://" onChange={set('cover')} aria-invalid={Boolean(errors.cover)} />
        <small className="muted-copy">{t('strCoverHelp')}</small>
        {fieldError(errors.cover)}
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={draft.publish} onChange={(event) => setDraft((current) => ({ ...current, publish: event.target.checked }))} />
        <span>{t('strFieldPublish')}</span>
      </label>
      <div className="wf-actions">
        <Button type="submit" variant="primary" disabled={saving || programs.length === 0}>{saving ? t('strSaving') : t('strSave')}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t('strCancel')}</Button>
      </div>
    </form>
  );
}

export default function StorePage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [sales, setSales] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');

  const refresh = useCallback(async () => {
    const [productRows, programRows, salesData] = await Promise.all([listProducts(), listMyWorkoutPrograms(), getSales()]);
    setProducts(productRows);
    setPrograms(programRows);
    setSales(salesData);
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  const programTitles = useMemo(() => new Map(programs.map((program) => [program.id, program.title])), [programs]);
  const salesByProduct = useMemo(() => new Map((sales?.products || []).map((item) => [item.product_id, item])), [sales]);
  const storeLink = `${window.location.origin}${publicStorePath(user?.id)}`;

  async function handleSave(payload) {
    setSaving(true);
    try {
      await saveProduct(payload);
      await refresh();
      setDraft(null);
      showToast(t('strSaved'));
    } catch (saveError) {
      showToast(`${t('strSaveError')} ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function run(product, action, successKey) {
    setBusyId(product.id);
    try {
      await action();
      await refresh();
      if (successKey) showToast(t(successKey));
    } catch (actionError) {
      showToast(`${t('strActionError')} ${actionError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(storeLink);
      showToast(t('strLinkCopied'));
    } catch {
      showToast(storeLink);
    }
  }

  const headerAction = !draft && <Button variant="primary" onClick={() => setDraft(emptyProductDraft())}>+ {t('strNew')}</Button>;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('strTitle')} description={t('strDescription')} action={headerAction} />

      {draft && <ProductForm key={draft.id || 'new'} initial={draft} programs={programs} saving={saving} onSave={handleSave} onCancel={() => setDraft(null)} />}

      {!draft && (
        <>
          {error && <div className="notice notice-error" role="alert">{t('strLoadError')} {error}</div>}
          {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}

          {sales && (
            <div className="store-stats">
              <div className="panel store-stat"><span className="eyebrow">{t('strStatSales')}</span><strong>{sales.orders_paid}</strong></div>
              <div className="panel store-stat"><span className="eyebrow">{t('strStatRevenue')}</span><strong dir="ltr">{formatRevenue(sales.revenue, locale)}</strong></div>
              <div className="panel store-stat"><span className="eyebrow">{t('strStatPending')}</span><strong>{sales.orders_pending}</strong></div>
            </div>
          )}

          <section className="panel store-share">
            <div><strong>{t('strShareTitle')}</strong><p className="muted-copy">{t('strShareHelp')}</p></div>
            <div className="store-share-row">
              <input className="field" readOnly dir="ltr" value={storeLink} aria-label={t('strShareTitle')} onFocus={(event) => event.target.select()} />
              <Button variant="secondary" size="small" onClick={copyLink}>{t('strCopyLink')}</Button>
            </div>
          </section>

          {!loading && !error && products.length === 0 && (
            <section className="panel">
              <div className="dashboard-empty"><h3>{t('strEmpty')}</h3><p>{t('strEmptyHelp')}</p><Button variant="primary" onClick={() => setDraft(emptyProductDraft())}>+ {t('strNew')}</Button></div>
            </section>
          )}

          <div className="store-grid">
            {products.map((product) => {
              const stat = salesByProduct.get(product.id);
              return (
                <article className={`panel store-card ${product.is_published ? '' : 'is-draft'}`} key={product.id}>
                  {isSecureUrl(product.cover_image_url) && <img className="store-cover" src={product.cover_image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                  <div className="template-card-heading">
                    <h3>{product.title}</h3>
                    <button
                      className={`wf-switch ${product.is_published ? 'is-on' : ''}`}
                      type="button"
                      role="switch"
                      aria-checked={product.is_published}
                      aria-label={`${t('strPublishToggle')}: ${product.title}`}
                      disabled={busyId === product.id}
                      onClick={() => run(product, () => setProductPublished(product.id, !product.is_published))}
                    >
                      <span className="wf-switch-thumb" />
                    </button>
                  </div>
                  {product.description && <p className="muted-copy" dir="auto">{product.description}</p>}
                  <div className="template-meta">
                    <strong className="store-price" dir="ltr">{formatPrice(product.price_cents, product.currency, locale, t('strFree'))}</strong>
                    <span className={`soft-badge ${product.is_published ? 'badge-green' : 'badge-muted'}`}>{product.is_published ? t('strPublished') : t('strDraft')}</span>
                    <span>{programTitles.get(product.program_template_id) || ''}</span>
                    <span>{stat?.sales || 0} {t('strSold')}</span>
                  </div>
                  <div className="template-actions">
                    <button className="text-action" type="button" onClick={() => setDraft(emptyProductDraft({ id: product.id, programId: product.program_template_id, title: product.title, description: product.description, price: centsToInput(product.price_cents), currency: product.currency, cover: product.cover_image_url || '', publish: product.is_published }))}>{t('strEdit')}</button>
                    <button className="text-action wf-danger" type="button" disabled={busyId === product.id} onClick={() => window.confirm(t('strDeleteConfirm')) && run(product, () => deleteProduct(product.id), 'strDeleted')}>{t('strDelete')}</button>
                  </div>
                </article>
              );
            })}
          </div>

          {sales && (
            <section className="panel">
              <div className="panel-heading"><div><span className="eyebrow">{t('strStatSales')}</span><h3>{t('strRecentSales')}</h3></div></div>
              {sales.recent.length === 0 && <p className="muted-copy">{t('strNoSales')}</p>}
              <ul className="store-sales">
                {sales.recent.map((order) => (
                  <li key={order.order_id}>
                    <span className="store-sale-title">{order.title}<small>{t('strBuyer')}: {order.buyer}</small></span>
                    {order.payment_mode === 'demo' && <span className="soft-badge badge-amber">{t('strDemoTag')}</span>}
                    <span className={`soft-badge ${order.delivered ? 'badge-green' : 'badge-amber'}`}>{order.delivered ? t('strDelivered') : t('strNotDelivered')}</span>
                    <strong dir="ltr">{formatPrice(order.amount_cents, order.currency, locale, t('strFree'))}</strong>
                    <small>{new Date(order.purchased_at).toLocaleDateString(locale)}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
