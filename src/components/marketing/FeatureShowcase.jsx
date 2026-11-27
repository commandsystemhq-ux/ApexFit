import { useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext.jsx';

const TABS = [
  { id: 1, icon: '\u21D5' },
  { id: 2, icon: '\u25D4' },
  { id: 3, icon: '\u2611' },
  { id: 4, icon: '\u2726' },
  { id: 5, icon: '\u25A3' },
];

// Five tabs: training, nutrition, weekly follow-up, Jack AI and the business side.
export default function FeatureShowcase() {
  const { t } = useLocale();
  const [active, setActive] = useState(1);

  function onKeyDown(event, index) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const flip = document.documentElement.dir === 'rtl' ? -1 : 1;
    const next = (index + step * flip + TABS.length) % TABS.length;
    setActive(TABS[next].id);
    event.currentTarget.parentElement.children[next]?.focus();
    event.preventDefault();
  }

  return (
    <div className="mk-showcase">
      <div className="mk-tabs" role="tablist" aria-label={t('mkShowTitle')}>
        {TABS.map((tab, index) => (
          <button
            key={tab.id} type="button" role="tab" id={`mk-tab-${tab.id}`} aria-selected={active === tab.id} aria-controls="mk-tabpanel"
            tabIndex={active === tab.id ? 0 : -1} onClick={() => setActive(tab.id)} onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span aria-hidden="true">{tab.icon}</span>{t(`mkTab${tab.id}Name`)}
          </button>
        ))}
      </div>
      <div className="mk-tabpanel" role="tabpanel" id="mk-tabpanel" aria-labelledby={`mk-tab-${active}`}>
        <div className="mk-tabpanel-copy">
          <h3>{t(`mkTab${active}Title`)}</h3>
          <p>{t(`mkTab${active}Text`)}</p>
        </div>
        <ul className="mk-tabpanel-points">
          {[1, 2, 3, 4].map((point) => <li key={point}>{t(`mkTab${active}B${point}`)}</li>)}
        </ul>
      </div>
    </div>
  );
}
