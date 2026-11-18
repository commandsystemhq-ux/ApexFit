import Button from '../components/Button.jsx';
import DashboardCompletion from '../components/DashboardCompletion.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

export default function DashboardPage({ onNavigate }) {
  const { t } = useLocale();
  const metrics = [
    { key: 'activeClients', icon: '◉' },
    { key: 'monthlyRevenue', icon: '$' },
    { key: 'plansCreated', icon: '✦' },
    { key: 'avgAdherence', icon: '↗' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="APEXFIT"
        title={t('dashboardTitle')}
        description={t('dashboardDescription')}
        action={<Button variant="primary" onClick={() => onNavigate('generator')}>{t('createPlan')}</Button>}
      />
      <section className="stats-grid dashboard-metrics" aria-label={t('dashboardTitle')}>
        {metrics.map(({ key, icon }) => (
          <article className="stat-card" key={key}>
            <div className="stat-top"><span className="stat-label">{t(key)}</span><span className="stat-icon" aria-hidden="true">{icon}</span></div>
            <strong className="stat-value">—</strong>
            <span className="stat-pending">{t('awaitingData')}</span>
          </article>
        ))}
      </section>
      <DashboardCompletion onOpen={() => onNavigate('tasks')} />
      <section className="dashboard-grid">
        <article className="panel alert-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('insights')}</span><h3>{t('insights')}</h3></div></div>
          <div className="dashboard-empty">
            <span className="feature-icon feature-icon-1" aria-hidden="true">✦</span>
            <p>{t('noInsights')}</p>
          </div>
        </article>
        <article className="panel adherence-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('clientRoster')}</span><h3>{t('weeklyAdherence')}</h3></div></div>
          <div className="dashboard-chart-empty" aria-hidden="true"><span>↗</span></div>
          <p className="dashboard-chart-note">{t('awaitingData')}</p>
        </article>
      </section>
      <section className="panel roster-panel">
        <div className="panel-heading roster-heading">
          <div><span className="eyebrow">{t('clients')}</span><h3>{t('clientRoster')}</h3></div>
        </div>
        <div className="dashboard-empty roster-empty">
          <span className="feature-icon" aria-hidden="true">◉</span>
          <h3>{t('noClientData')}</h3>
          <p>{t('noClientDataHelp')}</p>
        </div>
      </section>
    </>
  );
}
