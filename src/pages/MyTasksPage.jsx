import { useCallback, useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ProgressReports from '../components/ProgressReports.jsx';
import TaskList from '../components/TaskList.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { addMyTask, completeMyTask, deleteMyTask, getMyTasks } from '../services/accountabilityService.js';
import { TASK_KINDS, emptyTaskForm, fillText, groupTasks, rateTone, validateTaskForm } from '../services/accountabilityUtils.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';
import { getMyGamification } from '../services/communityService.js';
import { askJack } from '../services/jackUtils.js';

export default function MyTasksPage({ onNotify }) {
  const { t } = useLocale();
  const today = getLocalDateString();
  const [data, setData] = useState({ tasks: [], stats: null });
  const [summary, setSummary] = useState(null);
  const [state, setState] = useState({ loading: true, error: '' });
  const [form, setForm] = useState(() => ({ ...emptyTaskForm(today), kind: 'habit' }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tasks, gamification] = await Promise.all([getMyTasks(), getMyGamification().catch(() => null)]);
      setData(tasks);
      setSummary(gamification);
      setState({ loading: false, error: '' });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = groupTasks(data.tasks);
  const stats = data.stats;
  const update = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));

  async function toggle(task, done) {
    try {
      const saved = await completeMyTask(task.id, done);
      if (done) onNotify?.(saved.xp_awarded ? fillText(t('taskXpEarned'), { xp: saved.xp_awarded }) : t('taskCompleted'));
      await load();
    } catch (error) {
      onNotify?.(error.message);
    }
  }

  async function add(event) {
    event.preventDefault();
    const result = validateTaskForm(form, today, { self: true });
    setErrors(result.errors);
    if (!result.valid) return;
    setSaving(true);
    try {
      await addMyTask(result.payload);
      setForm({ ...emptyTaskForm(today), kind: form.kind });
      await load();
    } catch (error) {
      onNotify?.(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(task) {
    try {
      await deleteMyTask(task.id);
      await load();
    } catch (error) {
      onNotify?.(error.message);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="APEXFIT"
        title={t('myTasksTitle')}
        description={t('myTasksDescription')}
        action={<Button variant="secondary" onClick={() => askJack(t('taskAskSuggestSelf'))}>{'\u2726'} {t('taskAskJackSelf')}</Button>}
      />
      {state.error && <div className="notice notice-error" role="alert">{state.error}</div>}

      <section className="stats-grid" aria-label={t('tasksSummary')}>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">XP</span></div><strong className="stat-value" dir="ltr">{summary ? Number(summary.total_points) : '\u2014'}</strong></article>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">{t('taskLevel')}</span></div><strong className="stat-value" dir="ltr">{summary ? summary.level : '\u2014'}</strong></article>
        <article className="stat-card">
          <div className="stat-top"><span className="stat-label">{t('taskCompletionRate')}</span></div>
          <strong className={`stat-value tone-text-${rateTone(stats?.rate)}`} dir="ltr">{stats?.rate === null || stats?.rate === undefined ? '\u2014' : `${stats.rate}%`}</strong>
        </article>
        <article className="stat-card"><div className="stat-top"><span className="stat-label">{t('taskOpenTotal')}</span></div><strong className="stat-value">{stats ? Number(stats.pending) : '\u2014'}</strong></article>
      </section>

      <div className="client-feature-grid">
        <section className="panel chk-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('taskFromCoach')}</span><h3>{t('myTasksList')}</h3></div></div>
          {state.loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {!state.loading && data.tasks.length === 0 && <div className="empty-state">{t('myTasksEmpty')}</div>}
          <TaskList title={t('taskOverdue')} tasks={grouped.overdue} onToggle={toggle} onRemove={remove} canRemove={(task) => task.source === 'self'} />
          <TaskList title={t('taskOpen')} tasks={grouped.open} onToggle={toggle} onRemove={remove} canRemove={(task) => task.source === 'self'} />
          <TaskList title={t('taskDone')} tasks={grouped.done} onToggle={toggle} />
        </section>

        <aside className="chk-side">
          <form className="chk-form" onSubmit={add} noValidate>
            <h4>{t('taskAddOwn')}</h4>
            <p className="muted-copy">{t('taskOwnHelp')}</p>
            <label className="form-label">{t('taskType')}
              <select className="field" value={form.kind} onChange={update('kind')}>
                {TASK_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.icon} {t(kind.labelKey)}</option>)}
              </select>
            </label>
            <label className="form-label">{t('taskTitleLabel')}
              <input className="field" value={form.title} maxLength={120} onChange={update('title')} aria-invalid={Boolean(errors.title)} />
              {errors.title && <small className="field-error" role="alert">{t(errors.title)}</small>}
            </label>
            <label className="form-label">{t('taskDue')}
              <input className="field" type="date" value={form.dueDate} min={today} onChange={update('dueDate')} aria-invalid={Boolean(errors.dueDate)} />
              {errors.dueDate && <small className="field-error" role="alert">{t(errors.dueDate)}</small>}
            </label>
            <Button variant="primary" type="submit" disabled={saving}>{saving ? t('taskSaving') : t('taskAddButton')}</Button>
          </form>
        </aside>
      </div>

      <ProgressReports onNotify={onNotify} />
    </>
  );
}
