import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

function formatDate(value, locale) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
}

export default function BillingPage({ profile, onNotify }) {
  const { locale, t } = useLocale();
  const stateLabel = profile?.access_state === 'trialing' ? 'trialing' : profile?.access_state || 'expired';

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('billingTitle')} description={t('billingDescription')} />
      <section className="panel subscription-panel">
        <div>
          <span className="eyebrow">{t('plan')}</span>
          <h3>$39 / {t('month')} <span className={`soft-badge ${profile?.access_state === 'expired' ? 'badge-amber' : 'badge-green'}`}>{t(stateLabel)}</span></h3>
          <p>{t('billingProviderNotice')}</p>
        </div>
        <div className="subscription-details">
          <span><small>{t('trialStarted')}</small><strong>{formatDate(profile?.trial_started_at, locale)}</strong></span>
          <span><small>{t('trialEnds')}</small><strong>{formatDate(profile?.trial_ends_at, locale)}</strong></span>
          <span><small>{t('accountRole')}</small><strong>{profile ? t(profile.role) : t('signedOut')}</strong></span>
        </div>
        {profile?.role === 'coach' && profile.access_state !== 'active' && (
          <Button variant="primary" onClick={() => onNotify(t('checkoutUnavailable'))}>{t('subscribe')}</Button>
        )}
      </section>
    </>
  );
}
