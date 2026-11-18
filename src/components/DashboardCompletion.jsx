import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getTaskCompletionRates } from '../services/accountabilityService.js';
import { averageRate, fillText, rateTone, sortByRate } from '../services/accountabilityUtils.js';

// Who keeps up with their tasks, at a glance, for the coach's dashboard.
export default function DashboardCompletion({ onOpen }) {
  const { t } = useLocale();
  const [state, setState] = useState({ loading: true, rows: [], error: false });

  useEffect(() => {
    let active = true;
    getTaskCompletionRates(30)
      .then((rows) => active && setState({ loading: false, rows, error: false }))
      .catch(() => active && setState({ loading: false, rows: [], error: true }));
    return () => { active = false; };
  }, []);

  const average = averageRate(state.rows);
  const rows = sortByRate(state.rows).slice(0, 6);

  return (
    <section className="panel dash-completion" aria-label={t('taskCompletionRate')}>
      <div className="panel-heading roster-heading">
        <div><span className="eyebrow">{t('taskLast30')}</span><h3>{t('taskCompletionRate')}</h3></div>
        <div className="dash-completion-side">
          <strong className={`dash-completion-average tone-text-${rateTone(average)}`} dir="ltr">{average === null ? '\u2014' : `${average}%`}</strong>
          <Button variant="secondary" size="small" type="button" onClick={onOpen}>{t('taskOpenPage')}</Button>
        </div>
      </div>
      {state.loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.error && <p className="muted-copy">{t('taskLoadError')}</p>}
      {!state.loading && !state.error && state.rows.length === 0 && <p className="muted-copy">{t('taskNoClients')}</p>}
      <ul className="rate-list">
        {rows.map((row) => (
          <li key={row.client_id} className="rate-row">
            <button type="button" className="rate-select" onClick={onOpen}>
              <strong dir="auto">{row.client_name}</strong>
              <small>{row.assigned ? fillText(t('taskDoneOf'), { done: row.done, n: row.assigned }) : t('taskNothingAssigned')}</small>
            </button>
            <div className={`rate-bar tone-${rateTone(row.rate)}`} role="progressbar" aria-label={row.client_name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.rate ?? 0}>
              <span style={{ width: `${row.rate ?? 0}%` }} />
            </div>
            <span className="rate-value" dir="ltr">{row.rate === null ? '\u2014' : `${row.rate}%`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
