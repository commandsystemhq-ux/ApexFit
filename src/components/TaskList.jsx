import { useLocale } from '../contexts/LocaleContext.jsx';
import { TASK_KINDS } from '../services/accountabilityUtils.js';

const SOURCE_LABELS = { coach: 'taskByCoach', jack: 'taskByJack', self: 'taskBySelf' };

// A list of tasks. The coach side can remove open tasks; a client ticks them off (onToggle) and removes their own (onRemove).
export default function TaskList({ title, tasks, onToggle, onRemove, canRemove }) {
  const { t, locale } = useLocale();
  if (!tasks.length) return null;

  return (
    <div className="chk-group task-group">
      <h4>{title} <span className="soft-badge badge-muted">{tasks.length}</span></h4>
      <ul className="chk-list">
        {tasks.map((task) => {
          const kind = TASK_KINDS.find((item) => item.id === task.kind);
          const done = task.status === 'done';
          return (
            <li key={task.id} className={`chk-item task-item ${done ? 'is-done' : ''} ${task.is_overdue ? 'is-overdue' : ''}`}>
              {onToggle && (
                <input className="chk-check" type="checkbox" id={`task-${task.id}`} checked={done} onChange={(event) => onToggle(task, event.target.checked)} />
              )}
              <div className="chk-body">
                <label htmlFor={onToggle ? `task-${task.id}` : undefined} className="chk-title" dir="auto">{kind?.icon} {task.title}</label>
                {task.description && <small className="muted-copy" dir="auto">{task.description}</small>}
                <div className="chk-meta">
                  <span className="soft-badge badge-muted">{t(kind?.labelKey || 'taskKindHabit')}</span>
                  <span className={`soft-badge ${task.is_overdue ? 'badge-amber' : 'badge-blue'}`} dir="ltr">{new Date(`${task.due_date}T12:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                  <span className="soft-badge badge-green" dir="ltr">+{task.xp} XP</span>
                  <span className="soft-badge badge-muted">{t(SOURCE_LABELS[task.source])}</span>
                  {task.is_overdue && <span className="soft-badge badge-amber">{t('taskOverdueLabel')}</span>}
                </div>
              </div>
              {onRemove && (canRemove ? canRemove(task) : true) && !done && (
                <button className="text-action chk-delete" type="button" onClick={() => onRemove(task)}>{t('taskRemove')}</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
