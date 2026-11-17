import { useState } from 'react';
import NutritionTracker from '../components/NutritionTracker.jsx';
import PageHeader from '../components/PageHeader.jsx';
import WearablesPanel from '../components/WearablesPanel.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

const TABS = [
  { id: 'devices', labelKey: 'hltTabDevices' },
  { id: 'nutrition', labelKey: 'nutTabLabel' },
];

export default function IntegrationsPage() {
  const { t } = useLocale();
  const [tab, setTab] = useState('devices');

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('hltPageTitle')} description={t('hltPageDescription')} />
      <div className="client-feature-tabs" role="tablist" aria-label={t('hltPageTitle')}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`integrations-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="integrations-panel"
            className={`client-feature-tab ${tab === item.id ? 'is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div id="integrations-panel" role="tabpanel" aria-labelledby={`integrations-tab-${tab}`}>
        {tab === 'devices' ? <WearablesPanel /> : <NutritionTracker />}
      </div>
    </>
  );
}
