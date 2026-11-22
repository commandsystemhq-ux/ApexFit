import { useEffect, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMyEmailPreferences, setMyEmailMarketingOptOut } from '../services/campaignService.js';

// Lets a client choose whether coaches may send them marketing emails (the unsubscribe link in each email does the same).
export default function EmailPreferences() {
  const { t } = useLocale();
  const [optOut, setOptOut] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ kind: '', text: '' });

  useEffect(() => {
    let active = true;
    getMyEmailPreferences()
      .then((preferences) => { if (active) setOptOut(Boolean(preferences?.email_marketing_opt_out)); })
      .catch(() => { if (active) setMessage({ kind: 'error', text: t('emailPrefLoadError') }); });
    return () => { active = false; };
  }, []);

  async function change(receive) {
    setSaving(true);
    setMessage({ kind: '', text: '' });
    try {
      const saved = await setMyEmailMarketingOptOut(!receive);
      setOptOut(Boolean(saved?.email_marketing_opt_out));
      setMessage({ kind: 'info', text: t('emailPrefSaved') });
    } catch {
      setMessage({ kind: 'error', text: t('emailPrefError') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-row">
      <div>
        <h3>{t('emailPrefTitle')}</h3>
        <p>{t('emailPrefHelp')}</p>
        {message.text && <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={optOut === false} disabled={optOut === null || saving} onChange={(event) => change(event.target.checked)} />
        {t('emailPrefReceive')}
      </label>
    </div>
  );
}
