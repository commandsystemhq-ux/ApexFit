import { useState } from 'react';
import CalorieCalculator from './CalorieCalculator.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { clientLabel } from '../services/coachingUtils.js';

// The calculator inside the nutrition section: pick one of the coach's clients, then calculate for them.
export default function CalorieCalculatorPanel({ clients }) {
  const { t } = useLocale();
  const [clientId, setClientId] = useState('');
  return (
    <section className="panel calc-panel">
      <div className="panel-heading"><div><span className="eyebrow">{t('ccEyebrow')}</span><h3>{t('ccTitle')}</h3></div></div>
      <label className="form-label">
        {t('ccClient')}
        <select className="field" value={clientId} onChange={(event) => setClientId(event.target.value)}>
          <option value="">{clients.length === 0 ? t('wfNoClients') : t('ccChooseClient')}</option>
          {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
        </select>
      </label>
      {clientId && <CalorieCalculator key={clientId} clientId={clientId} />}
    </section>
  );
}
