import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { describeBilling, waitForActive } from '../services/billingUtils.js';
import { getBillingPortalLinks, getMySubscription, openSubscriptionCheckout } from '../services/paddleService.js';

function formatDate(value, locale) {
  if (!value) return '\u2014';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
}

const TONE = { good: 'badge-green', warn: 'badge-amber', bad: 'badge-red' };

export default function BillingPage({ profile, onNotify }) {
  const { locale, t } = useLocale();
  const { refreshProfile } = useAuth();
  const [subscription, setSubscription] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [links, setLinks] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadSubscription = useCallback(async () => {
    if (profile?.role !== 'coach') return;
    try {
      const data = await getMySubscription();
      if (mounted.current) setSubscription(data);
    } catch {
      if (mounted.current) setSubscription(null);
    }
  }, [profile?.role]);

  useEffect(() => { loadSubscription(); }, [loadSubscription, profile?.access_state]);

  const view = describeBilling({ profile, subscription });
  const busy = phase === 'opening' || phase === 'activating';

  async function activate() {
    setPhase('activating');
    const status = await waitForActive(refreshProfile);
    await loadSubscription();
    if (!mounted.current) return;
    setPhase('idle');
    if (status) onNotify?.(t('billingActivated'));
    else setError(t('billingStillActivating'));
  }

  async function subscribe() {
    setError('');
    setPhase('opening');
    try {
      await openSubscriptionCheckout({
        locale,
        onEvent: (kind) => {
          if (kind === 'completed') activate();
          else if (kind === 'closed') setPhase((current) => (current === 'activating' ? current : 'idle'));
          else if (kind === 'error') {
            setPhase('idle');
            setError(t('billingCheckoutError'));
          }
        },
      });
    } catch (checkoutError) {
      setPhase('idle');
      // A 503 carries the server's own explanation, which names the setting that is missing.
      setError(checkoutError.message || (checkoutError.status === 503 ? t('checkoutUnavailable') : t('billingCheckoutError')));
    }
  }

  async function manage() {
    setError('');
    try {
      const portal = await getBillingPortalLinks();
      setLinks(portal);
      window.open(portal.overview, '_blank', 'noopener,noreferrer');
    } catch (portalError) {
      setError(portalError.message || t('billingPortalError'));
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('billingTitle')} description={t('billingDescription')} />
      <section className="panel subscription-panel">
        <div>
          <span className="eyebrow">{t('plan')}</span>
          <h3>$39 / {t('month')} <span className={`soft-badge ${TONE[view.tone] || 'badge-muted'}`}>{t(view.statusKey)}</span></h3>
          <p>{t('billingPaddleNotice')}</p>
        </div>
        <div className="subscription-details">
          <span><small>{t('trialStarted')}</small><strong>{formatDate(profile?.trial_started_at, locale)}</strong></span>
          <span><small>{t(view.dateKey || 'trialEnds')}</small><strong>{formatDate(view.dateKey ? view.date : profile?.trial_ends_at, locale)}</strong></span>
          <span><small>{t('accountRole')}</small><strong>{profile ? t(profile.role) : t('signedOut')}</strong></span>
        </div>
        {view.notes.map((key) => <p className="billing-note" key={key}>{t(key)}</p>)}
        {phase === 'activating' && <div className="notice notice-info" role="status">{t('billingActivating')}</div>}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {(view.canSubscribe || view.canManage) && (
          <div className="billing-actions">
            {view.canSubscribe && <Button variant="primary" onClick={subscribe} disabled={busy}>{phase === 'opening' ? t('billingOpening') : t('subscribe')}</Button>}
            {view.canManage && <Button variant="secondary" onClick={manage} disabled={busy}>{t('billingManage')}</Button>}
            {links?.cancel && view.canManage && <a className="text-action" href={links.cancel} target="_blank" rel="noopener noreferrer">{t('billingCancel')}</a>}
          </div>
        )}
      </section>
    </>
  );
}