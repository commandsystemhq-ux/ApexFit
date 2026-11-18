import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ProgressReports from '../components/ProgressReports.jsx';
import TaskList from '../components/TaskList.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { assignClientTask, deleteClientTask, getClientTasks, getTaskCompletionRates } from '../services/accountabilityService.js';
import {
  TASK_KINDS, averageRate, emptyTaskForm, fillText, groupTasks, rateTone, sortByRate, validateTaskForm,
} from '../services/accountabilityUtils.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { askJack } from '../services/jackUtils.js';

export default function TasksPage({ onNotify }) {
  const { t } = useLocale();
  const [params, setParams] = useSearchParams();
  const clientId = params.get('client') || '';
  const today = getLocalDateString();
  const [rates, setRates] = useState([]);
  const [state, setState] = useState({ loading: true, error: '' });
  const [detail, setDetail] = useState({ loading: false, tasks: [], error: '' });
  const [form, setForm] = useState(() => emptyTaskForm(today));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const loadRates = useCallback(async () => {
    try {
      setRates(await getTaskCompletionRates(30));
      setState({ loading: false, error: '' });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }, []);

  const loadDetail = useCallback(async () => {
    if (!clientId) {
      setDetail({ loading: false, tasks: [], error: '' });
      return;
    }
    setDetail((current) => ({ ...current, loading: true }));
    try {
      const data = await getClientTasks(clientId);
      setDetail({ loading: false, tasks: data.tasks || [], error: '' });
    } catch (error) {
      setDetail({ loading: false, tasks: [], error: error.message });
    }
  }, [clientId]);

  useEffect(() => { loadRates(); }, [loadRates]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const sorted = useMemo(() => sortByRate(rates), [rates]);
  const average = averageRate(rates);
  const behind = rates.filter((row) => row.rate !== null && row.rate < 40).length;
  const overdue = rates.reduce((sum, row) => sum + Number(row.overdue || 0), 0);
  const open = rates.reduce((sum, row) => sum + Number(row.pending || 0), 0);
  const selected = rates.find((row) => row.client_id === clientId);
  const grouped = groupTasks(detail.tasks);

  const select = (id) => setParams(id ? { client: id } : {});
  const update = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));

  async function assign(event) {
    event.preventDefault();
    const result = validateTaskForm(form, today);
    setErrors(result.errors);
    if (!result.valid) return;
    setSaving(true);
    try {
      await assignClientTask(clientId, result.payload);
      setForm(emptyTaskForm(today));
      onNotify?.(t('taskAssigned'));
      await Promise.all([loadRates(), loadDetail()]);
    } catch (error) {
      onNotify?.(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(task) {
    try {
      await deleteClientTask(task.id);
      await Promise.all([loadRates(), loadDetail()]);
    } catch (error) {
      onNotify?.(error.message);
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('tasksTitle')} description={t('tasksDescription')} />
      {state.error && <div className="notice notice-error" role="alert">{state.error}</div>}

      <section className="stats-grid" aria-label={t('tasksSummary')}>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">{t('taskAvgCompletion')}</span></div><strong className="stat-value">{average === null ? '\u2014' : `${average}%`}</strong></article>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">{t('taskBehind')}</span></div><strong className="stat-value">{behind}</strong></article>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">{t('taskOpenTotal')}</span></div><strong className="stat-value">{open}</strong></article>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">{t('taskOverdueTotal')}</span></div><strong className="stat-value">{overdue}</strong></article>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('taskLast30')}</span><h3>{t('taskCompletionRate')}</h3></div></div>
        {state.loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!state.loading && rates.length === 0 && <div className="empty-state">{t('taskNoClients')}</div>}
        <ul className="rate-list">
          {sorted.map((row) => (
            <li key={row.client_id} className={`rate-row ${row.client_id === clientId ? 'is-selected' : ''}`}>
              <button type="button" className="rate-select" onClick={() => select(row.client_id)} aria-pressed={row.client_id === clientId}>
                <strong dir="auto">{row.client_name}</strong>
                <small>{row.assigned ? fillText(t('taskDoneOf'), { done: row.done, n: row.assigned }) : t('taskNothingAssigned')}</small>
              </button>
              <div className={`rate-bar tone-${rateTone(row.rate)}`} role="progressbar" aria-label={row.client_name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.rate ?? 0}>
                <span style={{ width: `${row.rate ?? 0}%` }} />
              </div>
              <span className="rate-value" dir="ltr">{row.rate === null ? '\u2014' : `${row.rate}%`}</span>
              {Number(row.overdue) > 0 && <span className="soft-badge badge-amber">{fillText(t('taskOverdueCount'), { n: row.overdue })}</span>}
              <span className="soft-badge badge-blue" dir="ltr">{Number(row.xp_total)} XP</span>
            </li>
          ))}
        </ul>
      </section>

      {rates.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">{t('taskManage')}</span><h3>{selected ? selected.client_name : t('taskPickClient')}</h3></div>
            <label className="form-label task-client-select">{t('taskClient')}
              <select className="field" value={clientId} onChange={(event) => select(event.target.value)}>
                <option value="">{t('taskPickClient')}</option>
                {rates.map((row) => <option key={row.client_id} value={row.client_id}>{row.client_name}</option>)}
              </select>
            </label>
          </div>
          {!selected && <p className="muted-copy">{t('taskPickHelp')}</p>}
          {selected && (
            <div className="task-manage">
              <form className="chk-form" onSubmit={assign} noValidate>
                <h4>{t('taskNew')}</h4>
                <label className="form-label">{t('taskType')}
                  <select className="field" value={form.kind} onChange={update('kind')}>
                    {TASK_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.icon} {t(kind.labelKey)}</option>)}
                  </select>
                </label>
                <label className="form-label">{t('taskTitleLabel')}
                  <input className="field" value={form.title} maxLength={120} onChange={update('title')} aria-invalid={Boolean(errors.title)} placeholder={t('taskTitlePlaceholder')} />
                  {errors.title && <small className="field-error" role="alert">{t(errors.title)}</small>}
                </label>
                <label className="form-label">{t('taskDetails')}
                  <textarea className="field" rows={2} value={form.description} maxLength={500} onChange={update('description')} />
                </label>
                <div className="task-form-row">
                  <label className="form-label">{t('taskDue')}
                    <input className="field" type="date" value={form.dueDate} min={today} onChange={update('dueDate')} aria-invalid={Boolean(errors.dueDate)} />
                    {errors.dueDate && <small className="field-error" role="alert">{t(errors.dueDate)}</small>}
                  </label>
                  <label className="form-label">{t('taskXp')}
                    <input className="field" type="number" min="1" max="100" value={form.xp} onChange={update('xp')} aria-invalid={Boolean(errors.xp)} dir="ltr" />
                    {errors.xp && <small className="field-error" role="alert">{t(errors.xp)}</small>}
                  </label>
                </div>
                <div className="template-actions">
                  <Button variant="primary" type="submit" disabled={saving}>{saving ? t('taskSaving') : t('taskAssign')}</Button>
                  <Button variant="secondary" type="button" onClick={() => askJack(fillText(t('taskAskSuggest'), { name: selected.client_name }))}>{'\u2726'} {t('taskAskJack')}</Button>
                </div>
              </form>
              <div className="task-lists">
                {detail.error && <div className="notice notice-error" role="alert">{detail.error}</div>}
                {detail.loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
                {!detail.loading && detail.tasks.length === 0 && <div className="empty-state">{t('taskNoneForClient')}</div>}
                <TaskList title={t('taskOverdue')} tasks={grouped.overdue} onRemove={remove} />
                <TaskList title={t('taskOpen')} tasks={grouped.open} onRemove={remove} />
                <TaskList title={t('taskDone')} tasks={grouped.done} />
              </div>
            </div>
          )}
        </section>
      )}

      {selected && <ProgressReports clientId={clientId} clientName={selected.client_name} onNotify={onNotify} />}
    </>
  );
}