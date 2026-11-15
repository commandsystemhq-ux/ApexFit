import { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout.jsx';
import Button from '../components/Button.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { signUpWithPassword } from '../services/authService.js';
import { describeAuthError, validateSignupForm } from '../services/profileUtils.js';
import { AUTH_PATHS } from '../routes.js';

const ROLES = [
  { id: 'coach', title: 'authRoleCoach', help: 'authRoleCoachHelp' },
  { id: 'client', title: 'authRoleClient', help: 'authRoleClientHelp' },
];

export default function SignupPage() {
  const { t } = useLocale();
  const { signInWithGoogle } = useAuth();
  const [form, setForm] = useState({ role: 'coach', fullName: '', email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const fieldError = (field) => errors[field] && <span className="field-error" role="alert">{t(errors[field])}</span>;

  async function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validateSignupForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy(true);
    setError('');
    try {
      const signedIn = await signUpWithPassword(form);
      if (!signedIn) setConfirmationSent(true);
    } catch (signUpError) {
      setError(describeAuthError(signUpError, t));
    } finally {
      setBusy(false);
    }
  }

  const footer = <>{t('signupHaveAccount')} <Link to={AUTH_PATHS.login}>{t('loginLink')}</Link></>;

  if (confirmationSent) {
    return (
      <AuthLayout title={t('signupCheckEmailTitle')} description={t('signupCheckEmailDescription')} footer={footer}>
        <div className="notice notice-info" role="status">{form.email}</div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('signupTitle')} description={t('signupDescription')} footer={footer}>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <fieldset className="role-picker">
          <legend className="form-label">{t('authRoleLabel')}</legend>
          {ROLES.map(({ id, title, help }) => (
            <label key={id} className={`role-option ${form.role === id ? 'is-selected' : ''}`}>
              <input type="radio" name="role" value={id} checked={form.role === id} onChange={update('role')} />
              <strong>{t(title)}</strong>
              <span>{t(help)}</span>
            </label>
          ))}
        </fieldset>
        <label className="form-label">{t('authFullName')}
          <input className="field" autoComplete="name" value={form.fullName} onChange={update('fullName')} required />
          {fieldError('fullName')}
        </label>
        <label className="form-label">{t('authEmail')}
          <input className="field" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
          {fieldError('email')}
        </label>
        <label className="form-label">{t('authPassword')}
          <input className="field" type="password" autoComplete="new-password" value={form.password} onChange={update('password')} required />
          {fieldError('password')}
        </label>
        <label className="form-label">{t('authConfirmPassword')}
          <input className="field" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={update('confirmPassword')} required />
          {fieldError('confirmPassword')}
        </label>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <Button variant="primary" size="large" type="submit" disabled={busy}>
          {busy ? t('authCreatingAccount') : form.role === 'coach' ? t('trial') : t('signupSubmit')}
        </Button>
      </form>
      <div className="auth-divider"><span>{t('authOr')}</span></div>
      <Button variant="secondary" size="large" className="auth-google" type="button" onClick={() => signInWithGoogle(form.role)}>
        <span aria-hidden="true">G</span> {t('signupGoogle')}
      </Button>
    </AuthLayout>
  );
}
