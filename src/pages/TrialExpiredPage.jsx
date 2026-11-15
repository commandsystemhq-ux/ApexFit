import Button from '../components/Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function TrialExpiredPage({ onNavigate }) {
  const { t } = useLocale();
  return (
    <section className="panel empty-panel">
      <div className="empty-panel-mark"><span className="feature-icon">◈</span></div>
      <h2>{t('trialExpiredTitle')}</h2>
      <p>{t('trialExpiredDescription')}</p>
      <Button variant="primary" onClick={() => onNavigate('billing')}>{t('subscribe')}</Button>
    </section>
  );
}
