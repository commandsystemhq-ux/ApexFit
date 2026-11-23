import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import DashboardCompletion from '../components/DashboardCompletion.jsx';
import ProgressionSuggestions from '../components/ProgressionSuggestions.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText, rateTone } from '../services/accountabilityUtils.js';
import { getCoachDashboard } from '../services/dashboardService.js';
import { DASHBOARD_DAYS, buildInsights, relativeDays, revenueParts, summarizeDashboard } from '../services/dashboardUtils.js';

const METRICS = [
  { key: 'activeClients', icon: '◉' },
  { key: 'monthlyRevenue', icon: '$' },
  { key: 'plansCreated', icon: '✦' },
  { key: 'avgAdherence', icon: '↗' },
];

// Every number here comes from the coach's own records (one database call that answers only for the signed-in coach).
// Nothing is estimated or invented: with no activity the cards show real zeros.
export default function DashboardPage({ onNavigate }) {
  const { t, locale } = useLocale();
  const [state, setState] = useState({ status: 'loading', summary: null });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      setState({ status: 'ready', summary: summarizeDashboard(await getCoachDashboard(DASHBOARD_DAYS)) });
    } catch {
      setState({ status: 'error', summary: null });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { summary, status } = state;
  const insights = useMemo(() => (summary ? buildInsights(summary.clients) : { items: [], hidden: 0 }), [summary]);
  const openProfile = (clientId) => onNavigate(`/clients?client=${clientId}`);
  const placeholder = status === 'error' ? '\u2014' : '\u2026';

  const revenue = summary ? revenueParts(summary.revenue, locale) : null;
  const cards = {
    activeClients: { value: summary?.activeClients, caption: t('dashCapActive') },
    monthlyRevenue: { value: revenue?.primary, caption: revenue?.others.length ? revenue.others.join(' · ') : t('dashCapRevenue') },
    plansCreated: { value: summary?.plansCreated, caption: t('dashCapPlans') },
    avgAdherence: { value: summary ? `${summary.avgAdherence}%` : undefined, caption: fillText(t('dashCapAdherence'), { days: DASHBOARD_DAYS }) },
  };

  const relative = (days) => relativeDays(days, locale) ?? t('dashNever');

  return (
    <>
      <PageHeader
        eyebrow="APEXFIT"
        title={t('dashboardTitle')}
        description={t('dashboardDescription')}
        action={<Button variant="primary" onClick={() => onNavigate('generator')}>{t('createPlan')}</Button>}
      />
      {status === 'error' && (
        <div className="notice notice-error" role="alert">
          {t('dashLoadError')} <button className="text-action" type="button" onClick={load}>{t('dashRetry')}</button>
        </div>
      )}
      <section className="stats-grid dashboard-metrics" aria-label={t('dashboardTitle')} aria-busy={status === 'loading'}>
        {METRICS.map(({ key, icon }) => (
          <article className="stat-card" key={key}>
            <div className="stat-top"><span className="stat-label">{t(key)}</span><span className="stat-icon" aria-hidden="true">{icon}</span></div>
            <strong className="stat-value" dir="auto">{status === 'ready' ? cards[key].value : placeholder}</strong>
            <span className="stat-pending">{status === 'ready' ? cards[key].caption : ''}</span>
          </article>
        ))}
      </section>
      <DashboardCompletion onOpen={() => onNavigate('tasks')} />
      <ProgressionSuggestions limit={5} />
      <section className="dashboard-grid">
        <article className="panel alert-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('insights')}</span><h3>{t('insights')}</h3></div></div>
          {status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {status === 'ready' && insights.items.length === 0 && (
            <div className="dashboard-empty">
              <span className="feature-icon feature-icon-1" aria-hidden="true">✦</span>
              <p>{summary.clients.length === 0 ? t('noInsights') : t('dashNoInsights')}</p>
            </div>
          )}
          {insights.items.length > 0 && (
            <ul className="insight-list">
              {insights.items.map((insight) => (
                <li className={`insight insight-${insight.severity}`} key={`${insight.clientId}-${insight.type}`}>
                  <span className="insight-dot" aria-hidden="true" />
                  <div className="insight-copy">
                    <strong dir="auto">{insight.name}</strong>
                    <p>{fillText(t(`dashIns_${insight.type}`), { ...insight.values, when: relativeDays(insight.values.days, locale) })}</p>
                  </div>
                  <button className="text-action" type="button" onClick={() => openProfile(insight.clientId)}>{t('dashOpenProfile')}</button>
                </li>
              ))}
            </ul>
          )}
          {insights.hidden > 0 && <p className="muted-copy">{fillText(t('dashMoreInsights'), { n: insights.hidden })}</p>}
        </article>

        <article className="panel adherence-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('clientRoster')}</span><h3>{t('weeklyAdherence')}</h3></div></div>
          {status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {status === 'ready' && summary.clients.length === 0 && <p className="dashboard-chart-note">{t('noClientData')}</p>}
          {status === 'ready' && summary.clients.length > 0 && (
            <>
              <ul className="rate-list adherence-list">
                {summary.clients.map((client) => (
                  <li className="rate-row adherence-row" key={client.client_id}>
                    <button type="button" className="rate-select" onClick={() => openProfile(client.client_id)} title={t('dashOpenProfile')}>
                      <strong dir="auto">{client.name}</strong>
                      <small>{fillText(t('dashOfGoal'), { done: client.workout_days_7, goal: client.goal })}</small>
                    </button>
                    <div className={`rate-bar tone-${rateTone(client.weekly)}`} role="progressbar" aria-label={client.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={client.weekly}>
                      <span style={{ width: `${client.weekly}%` }} />
                    </div>
                    <span className="rate-value" dir="ltr">{client.weekly}%</span>
                  </li>
                ))}
              </ul>
              <p className="dashboard-chart-note">{t('dashAdherenceNote')}</p>
            </>
          )}
        </article>
      </section>

      <section className="panel roster-panel">
        <div className="panel-heading roster-heading">
          <div><span className="eyebrow">{t('clients')}</span><h3>{t('clientRoster')}</h3></div>
          {status === 'ready' && summary.clients.length > 0 && <Button variant="secondary" size="small" onClick={() => onNavigate('clients')}>{t('clients')}</Button>}
        </div>
        {status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {status === 'ready' && summary.clients.length === 0 && (
          <div className="dashboard-empty roster-empty">
            <span className="feature-icon" aria-hidden="true">◉</span>
            <h3>{t('noClientData')}</h3>
            <p>{t('noClientDataHelp')}</p>
          </div>
        )}
        {status === 'ready' && summary.clients.length > 0 && (
          <div className="dash-roster">
            {summary.clients.map((client) => (
              <article className="dash-roster-row" key={client.client_id}>
                <div className="avatar avatar-blue" aria-hidden="true">{client.name.slice(0, 1).toUpperCase()}</div>
                <div className="dash-roster-main">
                  <strong dir="auto">{client.name}</strong>
                  <small>{t('dashJoined')} {new Date(client.joined_at).toLocaleDateString(locale)}</small>
                </div>
                <dl className="dash-roster-facts">
                  <div><dt>{t('dashLastWorkout')}</dt><dd>{relative(client.daysSinceWorkout)}</dd></div>
                  <div><dt>{t('dashLastFood')}</dt><dd>{relative(client.daysSinceFood)}</dd></div>
                  <div><dt>{t('dashPeriod')}</dt><dd dir="ltr">{client.period}%</dd></div>
                </dl>
                {Number(client.unread_messages) > 0 && <span className="soft-badge badge-blue">{client.unread_messages} {t('chatUnread')}</span>}
                <div className="dash-roster-actions">
                  <button className="text-action" type="button" onClick={() => openProfile(client.client_id)}>{t('dashOpenProfile')}</button>
                  <button className="text-action" type="button" onClick={() => onNavigate(`/messages?with=${client.client_id}`)}>{t('messages')}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
