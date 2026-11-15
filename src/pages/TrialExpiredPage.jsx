import { useNavigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PAGES } from '../routes.js';

export default function TrialExpiredPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  return (
    <section className="panel empty-panel">
      <div className="empty-panel-mark"><span className="feature-icon">◈</span></div>
      <h2>{t('trialExpiredTitle')}</h2>
      <p>{t('trialExpiredDescription')}</p>
      <Button variant="primary" onClick={() => navigate(PAGES.billing.path)}>{t('subscribe')}</Button>
    </section>
  );
}
