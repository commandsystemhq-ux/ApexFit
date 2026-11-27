import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import CalorieCalculatorPanel from '../components/CalorieCalculatorPanel.jsx';
import MealPlanEditor from '../components/MealPlanEditor.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { assignMealPlan, deleteMealPlan, getMealPlan, listMealPlans } from '../services/mealPlanService.js';
import { emptyPlan, hydratePlan } from '../services/mealPlanUtils.js';

// The coach's meal plans: ready-made templates, the plans given to clients, the builder, and giving a plan to a client.
export default function MealPlansPage() {
  const { t, locale } = useLocale();
  const [state, setState] = useState({ status: 'loading', plans: [], clients: [], error: '' });
  const [editing, setEditing] = useState(null);
  const [assignTo, setAssignTo] = useState({});
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [showCalculator, setShowCalculator] = useState(false);

  const load = useCallback(async () => {
    try {
      const [plans, clients] = await Promise.all([listMealPlans(), listMyClients()]);
      setState({ status: 'ready', plans, clients: clients.filter((client) => client.status === 'active'), error: '' });
    } catch (error) {
      setState({ status: 'error', plans: [], clients: [], error: error.message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clientName = useMemo(() => new Map(state.clients.map((client) => [client.client_id, clientLabel(client)])), [state.clients]);
  const templates = state.plans.filter((plan) => plan.is_template);
  const given = state.plans.filter((plan) => !plan.is_template);
  const say = (kind, text) => setNotice({ kind, text });

  async function edit(planId) {
    setNotice(null);
    setBusyId(planId);
    try {
      setEditing(hydratePlan(await getMealPlan(planId)));
    } catch (error) {
      say('error', `${t('mpLoadError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function give(plan) {
    const clientId = assignTo[plan.id];
    if (!clientId) {
      say('error', t('mpErr_client'));
      return;
    }
    setBusyId(plan.id);
    setNotice(null);
    try {
      await assignMealPlan(plan.id, clientId);
      await load();
      say('info', t('mpAssigned'));
    } catch (error) {
      say('error', `${t('mpActionError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function remove(plan) {
    if (!window.confirm(t('mpDeleteConfirm'))) return;
    setBusyId(plan.id);
    setNotice(null);
    try {
      await deleteMealPlan(plan.id);
      if (editing?.id === plan.id) setEditing(null);
      await load();
      say('info', t('mpDeleted'));
    } catch (error) {
      say('error', `${t('mpActionError')} ${error.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function saved() {
    setEditing(null);
    await load();
    say('info', t('mpSaved'));
  }

  const date = (value) => new Date(value).toLocaleDateString(locale);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('mpTitle')} description={t('mpDescription')} action={<><Button variant="secondary" aria-pressed={showCalculator} onClick={() => setShowCalculator((value) => !value)}>{t('ccOpen')}</Button> <Button variant="primary" onClick={() => { setNotice(null); setEditing(emptyPlan()); }}>{t('mpNewPlan')}</Button></>} />
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('mpLoadError')} {state.error}</div>}

      {showCalculator && state.status === 'ready' && <CalorieCalculatorPanel clients={state.clients} />}
      {editing && <MealPlanEditor initial={editing} clients={state.clients} onSaved={saved} onCancel={() => setEditing(null)} />}

      {state.status === 'ready' && (
        <div className="meal-plan-lists">
          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('mpTemplate')}</span><h3>{t('mpTemplates')}</h3></div></div>
            {templates.length === 0 && <div className="empty-state">{t('mpNoTemplates')}</div>}
            {templates.map((plan) => (
              <article className="meal-plan-row" key={plan.id}>
                <div><strong dir="auto">{plan.title}</strong><small>{date(plan.updated_at)}</small></div>
                <div className="meal-plan-row-actions">
                  <select className="field" aria-label={t('mpChooseClient')} value={assignTo[plan.id] || ''} onChange={(event) => setAssignTo((current) => ({ ...current, [plan.id]: event.target.value }))}>
                    <option value="">{t('mpChooseClient')}</option>
                    {state.clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
                  </select>
                  <Button variant="secondary" size="small" type="button" disabled={busyId === plan.id} onClick={() => give(plan)}>{t('mpGive')}</Button>
                  <button className="text-action" type="button" disabled={busyId === plan.id} onClick={() => edit(plan.id)}>{t('mpEdit')}</button>
                  <button className="text-action rpt-delete" type="button" disabled={busyId === plan.id} onClick={() => remove(plan)}>{t('mpDelete')}</button>
                </div>
              </article>
            ))}
          </section>
          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('mpForClient')}</span><h3>{t('mpGivenPlans')}</h3></div></div>
            {given.length === 0 && <div className="empty-state">{t('mpNoGiven')}</div>}
            {given.map((plan) => (
              <article className="meal-plan-row" key={plan.id}>
                <div><strong dir="auto">{plan.title}</strong><small dir="auto">{clientName.get(plan.client_id) || '\u2014'} · {date(plan.updated_at)}</small></div>
                <div className="meal-plan-row-actions">
                  <button className="text-action" type="button" disabled={busyId === plan.id} onClick={() => edit(plan.id)}>{t('mpEdit')}</button>
                  <button className="text-action rpt-delete" type="button" disabled={busyId === plan.id} onClick={() => remove(plan)}>{t('mpDelete')}</button>
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
    </>
  );
}