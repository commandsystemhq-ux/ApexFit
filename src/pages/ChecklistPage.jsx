import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  addChecklistTask, deleteChecklistTask, getChecklist, getChecklistSummary, setChecklistItem, updateChecklistTime,
} from '../services/checklistService.js';
import {
  ALL_DAYS, CATEGORIES, dayCompletion, emptyTaskForm, formatAmount, groupItems, itemPercent, quickSteps, replaceItem, streakOf,
  suggestedTasks, toggled, validateTaskForm, withAmount,
} from '../services/checklistUtils.js';
import { getLocalDateString, shiftDate } from '../services/clientTrackingUtils.js';

const CATEGORY_ICON = { workout: '\u{1F3CB}\uFE0F', meal: '\u{1F37D}\uFE0F', water: '\u{1F4A7}', habit: '\u2705', custom: '\u{1F4CC}' };

function weekdayName(day, locale) {
  return new Date(2024, 0, 7 + day).toLocaleDateString(locale, { weekday: 'short' });
}

function ChecklistItem({ item, editable, onToggle, onAmount, onRemove, onTime }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(item.remind_time || '');
  const percent = itemPercent(item);
  const steps = quickSteps(item);

  useEffect(() => {
    setTime(item.remind_time || '');
  }, [item.remind_time]);

  return (
    <li className={`chk-item ${item.is_done ? 'is-done' : ''}`}>
      <input
        className="chk-check"
        type="checkbox"
        id={`chk-${item.id}`}
        checked={item.is_done}
        disabled={!editable}
        onChange={(event) => onToggle(item, event.target.checked)}
      />
      <div className="chk-body">
        <label htmlFor={`chk-${item.id}`} className="chk-title" dir="auto">{item.title}</label>
        <div className="chk-meta">
          {item.template_id && <span className="soft-badge badge-muted">{t('chkRepeating')}</span>}
          {item.remind_time && <span className="soft-badge badge-blue" dir="ltr">{'\u{1F552}'} {item.remind_time}</span>}
          {item.target_amount && (
            <span className="chk-amount" dir="ltr">{formatAmount(item.progress_amount)} / {formatAmount(item.target_amount)} {item.unit || ''}</span>
          )}
        </div>
        {item.target_amount && (
          <div className="chk-bar" role="progressbar" aria-label={item.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
        )}
        {item.target_amount && editable && (
          <div className="chk-quick">
            {steps.map((step) => (
              <button key={step} type="button" className="text-action" onClick={() => onAmount(item, step)} dir="ltr">+{formatAmount(step)}{item.unit ? ` ${item.unit}` : ''}</button>
            ))}
            {item.progress_amount > 0 && <button type="button" className="text-action" onClick={() => onAmount(item, -steps[0])} dir="ltr">-{formatAmount(steps[0])}</button>}
          </div>
        )}
        {editing && (
          <div className="chk-reminder">
            <label className="form-label">{t('chkTime')}
              <input className="field" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
            <div className="template-actions">
              <Button variant="primary" size="small" type="button" onClick={async () => { await onTime(item, time || null); setEditing(false); }}>{t('chkReminderSave')}</Button>
              <Button variant="secondary" size="small" type="button" onClick={() => setEditing(false)}>{t('chkCancel')}</Button>
            </div>
          </div>
        )}
      </div>
      {editable && (
        <div className="chk-actions">
          <button type="button" className="text-action" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{t('chkReminder')}</button>
          <button type="button" className="text-action chk-delete" onClick={() => onRemove(item)}>{t('chkDelete')}</button>
        </div>
      )}
    </li>
  );
}

export default function ChecklistPage() {
  const { t, locale } = useLocale();
  const today = getLocalDateString();
  const [date, setDate] = useState(today);
  const [data, setData] = useState({ items: [], editable: true });
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState([]);
  const [notice, setNotice] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyTaskForm());
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const requestId = useRef(0);

  const say = (kind, text) => setNotice({ kind, text });

  const load = useCallback(async (day) => {
    const current = requestId.current + 1;
    requestId.current = current;
    try {
      const next = await getChecklist(day);
      if (requestId.current !== current) return;
      setData(next);
      setState('ready');
      setError('');
    } catch (loadError) {
      if (requestId.current !== current) return;
      setError(loadError.message);
      setState('error');
    }
  }, []);

  const loadSummary = useCallback(() => {
    getChecklistSummary(today, 7).then(setSummary).catch(() => {});
  }, [today]);

  useEffect(() => { setState('loading'); load(date); }, [date, load]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  const completion = useMemo(() => dayCompletion(data.items), [data.items]);
  const groups = useMemo(() => groupItems(data.items), [data.items]);
  const streak = useMemo(() => streakOf(summary), [summary]);
  const editable = Boolean(data.editable);

  const updateItems = (updater) => setData((current) => ({ ...current, items: updater(current.items) }));

  // The screen answers at once; the saved result from the database then confirms it, or the change is undone.
  async function change(item, optimistic, request) {
    updateItems((items) => replaceItem(items, optimistic));
    try {
      const saved = await request();
      updateItems((items) => replaceItem(items, saved));
      loadSummary();
    } catch (saveError) {
      updateItems((items) => replaceItem(items, item));
      say('error', `${t('chkSaveError')} ${saveError.message}`);
    }
  }

  const toggle = (item, done) => change(item, toggled(item, done), () => setChecklistItem(item.id, { done }));
  const addAmount = (item, delta) => change(item, withAmount(item, delta), () => setChecklistItem(item.id, { add: delta }));

  async function create(taskForm) {
    const result = validateTaskForm(taskForm);
    setErrors(result.errors);
    if (!result.valid) return false;
    setBusy('add');
    try {
      await addChecklistTask(date, result.payload);
      await load(date);
      loadSummary();
      return true;
    } catch (saveError) {
      say('error', `${t('chkSaveError')} ${saveError.message}`);
      return false;
    } finally {
      setBusy('');
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (await create(form)) {
      setForm(emptyTaskForm());
      setAdding(false);
      say('info', t('chkAdded'));
    }
  }

  async function addSuggested() {
    setBusy('suggested');
    try {
      for (const suggestion of suggestedTasks(t)) await addChecklistTask(date, validateTaskForm(suggestion).payload);
      await load(date);
      loadSummary();
      say('info', t('chkAdded'));
    } catch (saveError) {
      say('error', `${t('chkSaveError')} ${saveError.message}`);
    } finally {
      setBusy('');
    }
  }

  async function remove(item) {
    if (!window.confirm(t(item.template_id ? 'chkDeleteRepeatingConfirm' : 'chkDeleteConfirm'))) return;
    try {
      await deleteChecklistTask(item.id);
      await load(date);
      loadSummary();
      say('info', t('chkRemoved'));
    } catch (removeError) {
      say('error', `${t('chkSaveError')} ${removeError.message}`);
    }
  }

  async function changeTime(item, time) {
    try {
      const saved = await updateChecklistTime(item.id, time);
      updateItems((items) => replaceItem(items, saved));
    } catch (saveError) {
      say('error', `${t('chkSaveError')} ${saveError.message}`);
    }
  }

  const dayLabel = date === today ? t('chkToday') : date === shiftDate(today, -1) ? t('chkYesterday') : date === shiftDate(today, 1) ? t('chkTomorrow') : new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  const canGoBack = date > shiftDate(today, -30);
  const canGoForward = date < shiftDate(today, 1);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('chkPageTitle')} description={t('chkPageDescription')} />
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}

      <div className="client-feature-grid">
        <section className="panel chk-panel">
          <div className="chk-dayhead">
            <button type="button" className="icon-button" onClick={() => setDate(shiftDate(date, -1))} disabled={!canGoBack} aria-label={t('chkPrevDay')}>{'\u2039'}</button>
            <div className="chk-daylabel"><h3>{dayLabel}</h3><small dir="ltr">{date}</small></div>
            <button type="button" className="icon-button" onClick={() => setDate(shiftDate(date, 1))} disabled={!canGoForward} aria-label={t('chkNextDay')}>{'\u203A'}</button>
          </div>

          {state === 'ready' && completion.total > 0 && (
            <div className="chk-summary">
              <div className="chk-bar chk-bar-large" role="progressbar" aria-label={t('chkProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion.percent}><span style={{ width: `${completion.percent}%` }} /></div>
              <p><strong dir="ltr">{completion.done}/{completion.total}</strong> {t('chkDone')}{completion.left === 0 ? ` \u00B7 ${t('chkAllDone')}` : ''}</p>
            </div>
          )}

          {state === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {state === 'error' && <div className="notice notice-error" role="alert">{t('chkLoadError')} {error}</div>}
          {state === 'ready' && !editable && <p className="muted-copy">{t('chkReadOnly')}</p>}

          {state === 'ready' && data.items.length === 0 && (
            <div className="dashboard-empty">
              <h3>{t('chkEmpty')}</h3>
              <p>{t('chkEmptyHelp')}</p>
              {editable && <Button variant="primary" type="button" onClick={addSuggested} disabled={busy !== ''}>{busy === 'suggested' ? t('chkSaving') : t('chkAddSuggested')}</Button>}
            </div>
          )}

          {groups.map((group) => (
            <div className="chk-group" key={group.category}>
              <h4>{CATEGORY_ICON[group.category]} {t(`chkCat_${group.category}`)}</h4>
              <ul className="chk-list">
                {group.items.map((item) => (
                  <ChecklistItem key={item.id} item={item} editable={editable} onToggle={toggle} onAmount={addAmount} onRemove={remove} onTime={changeTime} />
                ))}
              </ul>
            </div>
          ))}

          {editable && state === 'ready' && (adding ? (
            <form className="chk-form" onSubmit={submitForm} noValidate>
              <h4>{t('chkAddTask')}</h4>
              <div className="form-grid">
                <label className="form-label">{t('chkTaskType')}
                  <select className="field" value={form.category} onChange={(event) => setForm({ ...emptyTaskForm(event.target.value), repeat: form.repeat, days: form.days, title: form.title, time: form.time })}>
                    {CATEGORIES.map((category) => <option key={category} value={category}>{t(`chkCat_${category}`)}</option>)}
                  </select>
                </label>
                <label className="form-label">{t('chkTaskTitle')}
                  <input className="field" value={form.title} maxLength={120} onChange={(event) => setForm({ ...form, title: event.target.value })} aria-invalid={Boolean(errors.title)} dir="auto" />
                  {errors.title && <small className="field-error">{t(errors.title)}</small>}
                </label>
                <label className="form-label">{t('chkTarget')} <small className="muted-copy">({t('chkOptional')})</small>
                  <input className="field" inputMode="decimal" value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} aria-invalid={Boolean(errors.target)} dir="ltr" />
                  {errors.target && <small className="field-error">{t(errors.target)}</small>}
                </label>
                <label className="form-label">{t('chkUnit')}
                  <input className="field" value={form.unit} maxLength={20} onChange={(event) => setForm({ ...form, unit: event.target.value })} aria-invalid={Boolean(errors.unit)} dir="auto" />
                  {errors.unit && <small className="field-error">{t(errors.unit)}</small>}
                </label>
                <label className="form-label">{t('chkTime')} <small className="muted-copy">({t('chkOptional')})</small>
                  <input className="field" type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} aria-invalid={Boolean(errors.time)} />
                  {errors.time && <small className="field-error">{t(errors.time)}</small>}
                </label>
                <label className="form-label">{t('chkRepeat')}
                  <select className="field" value={form.repeat} onChange={(event) => setForm({ ...form, repeat: event.target.value })}>
                    <option value="once">{t('chkRepeatOnce')}</option>
                    <option value="daily">{t('chkRepeatDaily')}</option>
                    <option value="days">{t('chkRepeatDays')}</option>
                  </select>
                </label>
              </div>
              {form.repeat === 'days' && (
                <fieldset className="chk-days">
                  <legend className="sr-only">{t('chkRepeatDays')}</legend>
                  {ALL_DAYS.map((day) => (
                    <label key={day} className="chk-day">
                      <input type="checkbox" checked={form.days.includes(day)} onChange={(event) => setForm({ ...form, days: event.target.checked ? [...form.days, day] : form.days.filter((value) => value !== day) })} />
                      {weekdayName(day, locale)}
                    </label>
                  ))}
                  {errors.days && <small className="field-error">{t(errors.days)}</small>}
                </fieldset>
              )}
              <div className="template-actions">
                <Button variant="primary" type="submit" disabled={busy !== ''}>{busy === 'add' ? t('chkSaving') : t('chkSave')}</Button>
                <Button variant="secondary" type="button" onClick={() => { setAdding(false); setErrors({}); }}>{t('chkCancel')}</Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" type="button" onClick={() => setAdding(true)}>{`+ ${t('chkAddTask')}`}</Button>
          ))}
        </section>

        <aside className="chk-side">
          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('chkWeek')}</span><h3>{t('chkStreak')}: <span dir="ltr">{streak}</span></h3></div></div>
            <div className="chk-week">
              {summary.map((day) => (
                <button type="button" key={day.date} className={`chk-week-day ${day.total > 0 && day.done === day.total ? 'is-complete' : ''} ${day.date === date ? 'is-selected' : ''}`} onClick={() => setDate(day.date)} title={`${day.date}: ${day.done}/${day.total}`}>
                  <span className="chk-week-fill" style={{ height: `${day.total ? Math.round((day.done / day.total) * 100) : 0}%` }} />
                  <small>{new Date(`${day.date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' })}</small>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
