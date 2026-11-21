import { Link } from 'react-router-dom';
import BrandMark from './BrandMark.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PUBLIC_PATHS } from '../routes.js';

const FOOTER_LINKS = [
  ['pricing', 'footerPricing'],
  ['terms', 'footerTerms'],
  ['privacy', 'footerPrivacy'],
  ['refunds', 'footerRefunds'],
];

// Shown on every page a visitor can open without logging in.
export default function PublicFooter() {
  const { t } = useLocale();
  return (
    <footer className="landing-footer public-footer">
      <div className="public-footer-brand"><BrandMark /><span>© {new Date().getFullYear()} ApexFit</span></div>
      <nav className="public-footer-links" aria-label={t('footerNav')}>
        {FOOTER_LINKS.map(([id, labelKey]) => <Link key={id} to={PUBLIC_PATHS[id]}>{t(labelKey)}</Link>)}
      </nav>
    </footer>
  );
}
