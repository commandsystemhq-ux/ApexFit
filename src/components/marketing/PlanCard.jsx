import { useLocale } from '../../contexts/LocaleContext.jsx';
import { COUNTRY_FLAGS, chargedPrice, currencyLabel, fill, formatLocal, headlinePrice, isApproximate, isolate } from '../../services/pricingUtils.js';

const FEATURE_KEYS = Array.from({ length: 12 }, (_, index) => `mkPlanF${index + 1}`);

// The one plan with everything in it, priced for the visitor's country (from IP, so a VPN changes it). `children` are the buttons.
export default function PlanCard({ pricing, children }) {
  const { locale, t } = useLocale();
  const approximate = isApproximate(pricing);
  const headline = headlinePrice(pricing, locale);
  const badge = pricing.localized
    ? `${COUNTRY_FLAGS[pricing.region]} ${fill(t('mkBadgeCountry'), { country: t(`mkCountry${pricing.region}`) })}`
    : `${COUNTRY_FLAGS.GLOBAL} ${t('mkBadgeGlobal')}`;
  const trialPrice = approximate ? `${t('mkApproxTag')} ${headline}` : headline;

  return (
    <article className="mk-plan" aria-labelledby="mk-plan-name">
      <div className="mk-plan-main">
        <span className="mk-country-badge" data-region={pricing.region}>{badge}</span>
        <h3 id="mk-plan-name">{t('mkPlanName')}</h3>
        <div className="mk-plan-price" aria-live="polite">
          {approximate && <small className="mk-approx-tag">{t('mkApproxTag')}</small>}
          <strong>{headline}</strong>
          <span>{t('mkPerMonth')}</span>
        </div>
        {approximate && (
          <p className="mk-approx-note">
            {fill(t('mkApproxNote'), {
              price: formatLocal(pricing.local, locale), usd: isolate(chargedPrice(pricing)), currency: currencyLabel(pricing.local.currency, locale),
            })}
          </p>
        )}
        <p className="mk-plan-trial">{fill(t('mkTrialLine'), { days: pricing.trialDays, price: trialPrice })}</p>
        <div className="mk-plan-actions">{children}</div>
        <p className="mk-plan-fine">{t('mkCancelNote')}</p>
      </div>
      <div className="mk-plan-features">
        <h4>{t('mkPlanIncludes')}</h4>
        <ul>
          {FEATURE_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
        <p className="mk-plan-noaddons">{t('mkNoAddons')}</p>
      </div>
    </article>
  );
}
