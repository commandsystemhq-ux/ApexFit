import Button from '../components/Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function CoachSignInPage({ user, profile, onSignIn }) {
  const { t } = useLocale();

  return (
    <section className="panel empty-panel">
      <div className="empty-panel-mark"><span className="feature-icon">⚡</span></div>
      <h2>{t('coachRequiredTitle')}</h2>
      <p>{user && !profile ? t('accountLoading') : t('coachRequiredDescription')}</p>
      {!user && <Button variant="primary" onClick={() => onSignIn('coach')}>{t('signIn')}</Button>}
    </section>
  );
}
