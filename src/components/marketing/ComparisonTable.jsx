import { useLocale } from '../../contexts/LocaleContext.jsx';
import { COMPARISON_SOURCES, COMPARISON_VERIFIED_ON, fill } from '../../services/pricingUtils.js';

export const COMPARISON_ROWS = [1, 2, 3, 4, 5, 6, 7, 8];

// ApexFit against typical international platforms and against doing it by hand. The middle column only states what the
// providers' public pricing pages say, and the note under the table gives the sources and the date they were checked.
export default function ComparisonTable() {
  const { t } = useLocale();
  const [before, after = ''] = fill(t('mkCmpSourceNote'), { date: COMPARISON_VERIFIED_ON }).split('{sources}');

  return (
    <div className="mk-compare">
      <div className="mk-table-scroll" role="region" aria-label={t('mkCmpTitle')} tabIndex={0}>
        <table className="mk-table">
          <caption className="sr-only">{t('mkCmpSub')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('mkCmpColFeature')}</th>
              <th scope="col" className="mk-col-apex">{t('mkCmpColApex')}</th>
              <th scope="col">{t('mkCmpColForeign')}</th>
              <th scope="col">{t('mkCmpColManual')}</th>
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row) => (
              <tr key={row}>
                <th scope="row">{t(`mkCmpR${row}L`)}</th>
                <td className="mk-col-apex">{t(`mkCmpR${row}A`)}</td>
                <td>{t(`mkCmpR${row}F`)}</td>
                <td>{t(`mkCmpR${row}M`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mk-source-note">
        {before}
        {COMPARISON_SOURCES.map((source, index) => (
          <span key={source.href}>
            {index > 0 && ', '}
            <a href={source.href} target="_blank" rel="noopener noreferrer" dir="ltr">{source.label}</a>
          </span>
        ))}
        {after}
      </p>
    </div>
  );
}
