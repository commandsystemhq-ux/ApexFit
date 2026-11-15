import { useLocale } from '../contexts/LocaleContext.jsx';
import { localeNames, supportedLocales } from '../i18n/translations.js';

export default function LanguageToggle() {
  const { locale, setLocale, t } = useLocale();
  return (
    <label className="language-control">
      <span className="sr-only">{t('language')}</span>
      <select className="field language-select" value={locale} onChange={(event) => setLocale(event.target.value)} aria-label={t('language')}>
        {supportedLocales.map((code) => <option key={code} value={code}>{localeNames[code]}</option>)}
      </select>
    </label>
  );
}
