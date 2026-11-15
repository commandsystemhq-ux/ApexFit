import { Link } from 'react-router-dom';
import BrandMark from './BrandMark.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { AUTH_PATHS } from '../routes.js';

export default function AuthLayout({ title, description, footer, children }) {
  const { t } = useLocale();
  return (
    <div className="auth-page">
      <header className="auth-header">
        <Link className="landing-brand" to={AUTH_PATHS.home} aria-label={`ApexFit ${t('home')}`}><BrandMark /></Link>
        <LanguageToggle />
      </header>
      <main className="auth-main">
        <section className="auth-card panel">
          <div className="auth-card-heading">
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {children}
          <p className="auth-footer">{footer}</p>
        </section>
      </main>
    </div>
  );
}
