import { useNavigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { usePricing } from '../hooks/usePricing.js';
import { fill, headlinePrice } from '../services/pricingUtils.js';
import { PAGES } from '../routes.js';

export default function TrialExpiredPage() {
  const { locale, t } = useLocale();
  const { pricing } = usePricing();
  const price = headlinePrice(pricing, locale);
  const navigate = useNavigate();
  return (
    <section className="panel empty-panel">
      <div className="empty-panel-mark"><span className="feature-icon">◈</span></div>
      <h2>{t('trialExpiredTitle')}</h2>
      <p>{fill(t('mkExpiredText'), { price })}</p>
      <Button variant="primary" onClick={() => navigate(PAGES.billing.path)}>{fill(t('mkSubscribeFor'), { price })}</Button>
    </section>
  );
}
