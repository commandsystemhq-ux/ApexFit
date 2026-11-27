import { useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext.jsx';

const VIEWS = [['dashboard', 'dashboard'], ['nutrition', 'mkTab2Name'], ['checkin', 'mkTab3Name']];
const WEEK_BARS = [58, 72, 64, 86, 78, 92, 88];
const MACROS = [['P', 42, 'mk-bar-blue'], ['C', 55, 'mk-bar-cyan'], ['F', 30, 'mk-bar-amber']];

function onTabKeys(event, index, setView) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const flip = document.documentElement.dir === 'rtl' ? -1 : 1;
  const next = (index + step * flip + VIEWS.length) % VIEWS.length;
  setView(VIEWS[next][0]);
  event.currentTarget.parentElement.children[next]?.focus();
  event.preventDefault();
}

// A live, clickable sketch of the coach workspace built from CSS only, so it never depends on an image that can break.
export default function AppPreview() {
  const { t } = useLocale();
  const [view, setView] = useState('dashboard');

  return (
    <figure className="mk-preview" aria-label={t('mkPvAria')}>
      <div className="mk-preview-bar" aria-hidden="true"><i /><i /><i /><span>{t('mkPvTitle')}</span></div>
      <div className="mk-preview-tabs" role="tablist" aria-label={t('mkPvTitle')}>
        {VIEWS.map(([id, labelKey], index) => (
          <button
            key={id} type="button" role="tab" id={`mk-pv-tab-${id}`} aria-selected={view === id} aria-controls="mk-pv-panel"
            tabIndex={view === id ? 0 : -1} onClick={() => setView(id)} onKeyDown={(event) => onTabKeys(event, index, setView)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="mk-preview-panel" role="tabpanel" id="mk-pv-panel" aria-labelledby={`mk-pv-tab-${view}`}>
        {view === 'dashboard' && (
          <>
            <div className="mk-preview-stats">
              <div><small>{t('mkPvClients')}</small><strong>48</strong></div>
              <div><small>{t('mkPvAdherence')}</small><strong>92%</strong></div>
            </div>
            <div className="mk-preview-chart" aria-hidden="true">
              {WEEK_BARS.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
            </div>
          </>
        )}

        {view === 'nutrition' && (
          <div className="mk-preview-meal">
            <div className="mk-meal-head"><small>{t('mkPvMealLabel')}</small><span className="mk-ramadan-tag">{t('mkPvMealTag')}</span></div>
            <strong>{t('mkPvMealName')}</strong>
            <p>{t('mkPvMealMacros')}</p>
            <div className="mk-macros" aria-hidden="true">
              {MACROS.map(([name, value, tone]) => (
                <div key={name}><span>{name}</span><i className={tone} style={{ width: `${value}%` }} /></div>
              ))}
            </div>
          </div>
        )}

        {view === 'checkin' && (
          <div className="mk-preview-checkin">
            <div className="mk-checkin-head"><strong>{t('mkPvWeekTitle')}</strong><span>{t('mkPvClientName')}</span></div>
            <div className="mk-photos">
              <div className="mk-photo"><span className="mk-silhouette mk-silhouette-before" aria-hidden="true" /><small>{t('mkPvPhotoBefore')}</small></div>
              <div className="mk-photo"><span className="mk-silhouette mk-silhouette-after" aria-hidden="true" /><small>{t('mkPvPhotoAfter')}</small></div>
            </div>
            <p className="mk-weight-change"><strong dir="ltr">-4.2</strong> {t('mkPvWeightLost')}</p>
          </div>
        )}
      </div>

      <div className="mk-jack">
        <span className="mk-jack-avatar" aria-hidden="true">J</span>
        <div><strong>{t('mkPvJackName')}</strong><p>{t('mkPvJackMsg')}</p></div>
      </div>
    </figure>
  );
}
