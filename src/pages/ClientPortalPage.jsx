import Button from '../components/Button.jsx';
import BrandMark from '../components/BrandMark.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function ClientPortalPage({ user, profile, onSignIn }) {
  const { t } = useLocale();

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('portalTitle')} description={t('portalDescription')} />
      <div className="phone-stage">
        <section className="phone-frame client-portal-empty">
          <div className="phone-notch" />
          <header className="phone-header">
            <BrandMark compact />
            <span className="soft-badge badge-blue">{profile?.role === 'client' ? t('client') : t('portalTitle')}</span>
          </header>
          <div className="phone-content dashboard-empty">
            <span className="feature-icon" aria-hidden="true">▣</span>
            <h3>{user && profile?.role === 'client' ? t('portalEmpty') : t('portalSignIn')}</h3>
            {!user && <Button variant="primary" onClick={() => onSignIn('client')}>{t('clientSignIn')}</Button>}
          </div>
        </section>
      </div>
    </>
  );
}
