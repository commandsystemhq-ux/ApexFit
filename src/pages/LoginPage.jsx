import { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout.jsx';
import Button from '../components/Button.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { signInWithPassword } from '../services/authService.js';
import { describeAuthError, isValidEmail } from '../services/profileUtils.js';
import { AUTH_PATHS } from '../routes.js';

export default function LoginPage() {
  const { t } = useLocale();
  const { signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!isValidEmail(email)) {
      setError(t('authEmailInvalid'));
      return;
    }
    if (!password) {
      setError(t('authPasswordRequired'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await signInWithPassword(email, password);
    } catch (signInError) {
      setError(describeAuthError(signInError, t));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('loginTitle')}
      description={t('loginDescription')}
      footer={<>{t('loginNoAccount')} <Link to={AUTH_PATHS.signup}>{t('signupLink')}</Link></>}
    >
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <label className="form-label">{t('authEmail')}
          <input className="field" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label className="form-label">{t('authPassword')}
          <input className="field" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <Button variant="primary" size="large" type="submit" disabled={busy}>{busy ? t('authSigningIn') : t('loginSubmit')}</Button>
      </form>
      <div className="auth-divider"><span>{t('authOr')}</span></div>
      <Button variant="secondary" size="large" className="auth-google" type="button" onClick={() => signInWithGoogle(null)}>
        <span aria-hidden="true">G</span> {t('signIn')}
      </Button>
    </AuthLayout>
  );
}
