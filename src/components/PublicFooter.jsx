import { Link } from 'react-router-dom';
import BrandMark from './BrandMark.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { AUTH_PATHS, PUBLIC_PATHS } from '../routes.js';

const FOOTER_LINKS = [
  ['pricing', 'footerPricing'],
  ['terms', 'footerTerms'],
  ['privacy', 'footerPrivacy'],
  ['refunds', 'footerRefunds'],
];

const PRODUCT_LINKS = [['features', 'mkNavFeatures'], ['compare', 'mkNavCompare'], ['faq', 'mkNavFaq']];

// Shown on every page a visitor can open without logging in.
export default function PublicFooter() {
  const { t } = useLocale();
  return (
    <footer className="mk-footer">
      <div className="mk-footer-grid">
        <div className="mk-footer-brand">
          <BrandMark />
          <p>{t('mkFooterTag')}</p>
        </div>
        <nav aria-label={t('mkFooterProduct')}>
          <h2>{t('mkFooterProduct')}</h2>
          <ul>
            {PRODUCT_LINKS.map(([id, labelKey]) => <li key={id}><Link to={`${AUTH_PATHS.home}#${id}`}>{t(labelKey)}</Link></li>)}
            <li><Link to={PUBLIC_PATHS.pricing}>{t('footerPricing')}</Link></li>
          </ul>
        </nav>
        <nav aria-label={t('footerNav')}>
          <h2>{t('mkFooterCompany')}</h2>
          <ul>
            {FOOTER_LINKS.filter(([id]) => id !== 'pricing').map(([id, labelKey]) => <li key={id}><Link to={PUBLIC_PATHS[id]}>{t(labelKey)}</Link></li>)}
          </ul>
        </nav>
        <nav aria-label={t('mkFooterAccount')}>
          <h2>{t('mkFooterAccount')}</h2>
          <ul>
            <li><Link to={AUTH_PATHS.login}>{t('loginLink')}</Link></li>
            <li><Link to={AUTH_PATHS.signup}>{t('signupLink')}</Link></li>
          </ul>
        </nav>
      </div>
      <p className="mk-footer-legal">&copy; {new Date().getFullYear()} ApexFit</p>
    </footer>
  );
}
