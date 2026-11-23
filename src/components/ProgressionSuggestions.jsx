import { useCallback, useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useExerciseBundle } from '../hooks/useExerciseBundle.js';
import { fillText } from '../services/accountabilityUtils.js';
import { displayName } from '../services/exerciseI18n.js';
import { decideSuggestion, listSuggestions, refreshSuggestions } from '../services/progressionService.js';
import { sessionDates, suggestionNumbers, suggestionTextKey } from '../services/progressionUtils.js';

// Weight and repetition suggestions built from what clients really lifted. They are only suggestions: the plan changes
// when the coach presses Apply. `clientId` limits the list to one client; `limit` shortens it (the dashboard shows a few).
export default function ProgressionSuggestions({ clientId = null, limit = null, showClient = true }) {
  const { t, locale } = useLocale();
  const bundle = useExerciseBundle(locale);
  const [state, setState] = useState({ status: 'loading', items: [], error: '' });
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      await refreshSuggestions(clientId).catch(() => 0);
      setState({ status: 'ready', items: (await listSuggestions({ clientId })) || [], error: '' });
    } catch (error) {
      setState({ status: 'error', items: [], error: error.message });
    }
  }, [clientId]);

  useEffect(() => {
    setState({ status: 'loading', items: [], error: '' });
    load();
  }, [load]);

  async function decide(item, apply) {
    setBusyId(item.id);
    setNotice(null);
    try {
      await decideSuggestion(item.id, apply);
      setState((current) => ({ ...current, items: current.items.filter((row) => row.id !== item.id) }));
      setNotice({ kind: 'info', text: t(apply ? 'pgApplied' : 'pgDismissed') });
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('pgActionError')} ${error.message}` });
    } finally {
      setBusyId('');
    }
  }

  const shown = limit ? state.items.slice(0, limit) : state.items;

  return (
    <section className="panel progression-panel" aria-label={t('pgTitle')}>
      <div className="panel-heading">
        <div><span className="eyebrow">{t('pgEyebrow')}</span><h3>{t('pgTitle')}</h3></div>
        <button type="button" className="text-action" onClick={() => { setState({ status: 'loading', items: [], error: '' }); load(); }}>{t('dashRetry')}</button>
      </div>
      <p className="muted-copy">{t('pgIntro')}</p>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('pgLoadError')} {state.error}</div>}
      {state.status === 'ready' && shown.length === 0 && <div className="empty-state">{t('pgEmpty')}</div>}
      <ul className="progression-list">
        {shown.map((item) => {
          const numbers = suggestionNumbers(item);
          const exercise = displayName({ name: item.exercise_name, name_i18n: item.exercise_name_i18n }, locale, bundle);
          return (
            <li className="progression-item" key={item.id}>
              <div className="progression-copy">
                {showClient && <strong dir="auto">{item.client_name}</strong>}
                <p dir="auto">{fillText(t(suggestionTextKey(item)), { exercise, ...numbers })}</p>
                <small dir="auto">{fillText(t('pgReason'), { reps: item.reason?.top_reps ?? '', sets: item.reason?.sets ?? '', dates: sessionDates(item, locale) })}</small>
              </div>
              <div className="progression-actions">
                <Button variant="primary" size="small" type="button" disabled={busyId === item.id} onClick={() => decide(item, true)}>{'\u2705'} {t('pgApply')}</Button>
                <Button variant="secondary" size="small" type="button" disabled={busyId === item.id} onClick={() => decide(item, false)}>{'\u274C'} {t('pgDismiss')}</Button>
              </div>
            </li>
          );
        })}
      </ul>
      {limit && state.items.length > limit && <p className="muted-copy">{fillText(t('dashMoreInsights'), { n: state.items.length - limit })}</p>}
    </section>
  );
}