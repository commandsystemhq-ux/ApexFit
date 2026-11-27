import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { disablePush, enablePush, getPushState } from '../services/pushService.js';
import { announceNotificationsChanged } from '../services/notificationService.js';
import { deleteReminder, listReminders, saveReminder } from '../services/reminderService.js';
import {
  ALL_DAYS, REMINDER_KINDS, REMINDER_KIND_ICONS, REMINDER_KIND_KEYS, REMINDER_LIMIT, REMINDER_MESSAGE_MAX, REMINDER_TITLE_MAX,
  defaultTitleKey, describeDays, emptyReminderForm, formatReminderTime, localTimezone, reminderToForm, toggleDay, validateReminder, weekdayLabel,
} from '../services/reminderUtils.js';

function PushPanel() {
  const { t } = useLocale();
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      if (state === 'subscribed') await disablePush();
      else await enablePush();
      setState(await getPushState());
    } catch (toggleError) {
      setError(toggleError.message);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return null;
  return (
    <section className="panel reminder-push">
      <div className="panel-heading"><div><span className="eyebrow">{t('rmTitle')}</span><h3>{t('pushTitle')}</h3></div></div>
      <p className="muted-copy">{t('rmPushHelp')}</p>
      {state === 'unsupported' && <div className="notice notice-info" role="status">{t('pushUnsupported')}</div>}
      {state === 'denied' && <div className="notice notice-info" role="status">{t('pushDenied')}</div>}
      {error && <div className="notice notice-error" role="alert">{t('pushError')} {error}</div>}
      {(state === 'available' || state === 'subscribed') && (
        <Button variant={state === 'subscribed' ? 'secondary' : 'primary'} onClick={toggle} disabled={busy}>{t(state === 'subscribed' ? 'pushDisable' : 'pushEnable')}</Button>
      )}
    </section>
  );
}

// Custom reminders (water, a meal, a workout, the weekly check-in, anything). They come due at the chosen time on the
// chosen days and show up in the notification center (and as a push message when push is switched on). A coach can also
// schedule a reminder for one of their clients.
export default function RemindersPage() {
  const { t, locale } = useLocale();
  const { user, profile } = useAuth();
  const isCoach = profile?.role === 'coach';
  const [state, setState] = useState({ status: 'loading', items: [], clients: [], error: '' });
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const timezone = useMemo(() => localTimezone(), []);

  const load = useCallback(async () => {
    try {
      const [items, clients] = await Promise.all([listReminders(), isCoach ? listMyClients().catch(() => []) : Promise.resolve([])]);
      setState({ status: 'ready', items, clients: clients.filter((client) => client.status === 'active'), error: '' });
    } catch (error) {
      setState({ status: 'error', items: [], clients: [], error: error.message });
    }
  }, [isCoach]);

  useEffect(() => {
    load();
  }, [load]);

  const clientName = useMemo(() => new Map(state.clients.map((client) => [client.client_id, clientLabel(client)])), [state.clients]);
  const say = (kind, text) => setNotice({ kind, text });
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  function startNew() {
    setNotice(null);
    setErrors({});
    setForm({ ...emptyReminderForm('water'), title: t(defaultTitleKey('water')) });
  }

  function changeKind(kind) {
    setForm((current) => {
      const untouched = !current.title.trim() || REMINDER_KINDS.some((key) => current.title === t(defaultTitleKey(key)));
      return { ...current, kind, title: untouched ? t(defaultTitleKey(kind)) : current.title };
    });
  }

  async function save(event) {
    event.preventDefault();
    const result = validateReminder(form, timezone);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy(true);
    setNotice(null);
    try {
      await saveReminder(result.payload);
      setForm(null);
      await load();
      announceNotificationsChanged();
      say('info', t('rmSaved'));
    } catch (error) {
      say('error', `${t('rmActionError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(item, active) {
    setBusy(true);
    setNotice(null);
    try {
      await saveReminder({
        id: item.id, kind: item.kind, title: item.title, message: item.message, time: item.time_of_day, days: item.days_of_week,
        timezone: item.timezone, active, target: item.target_id === user?.id ? null : item.target_id,
      });
      await load();
    } catch (error) {
      say('error', `${t('rmActionError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    if (!window.confirm(t('rmDeleteConfirm'))) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteReminder(item.id);
      await load();
      say('info', t('rmDeleted'));
    } catch (error) {
      say('error', `${t('rmActionError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (key) => errors[key] && <small className="field-error" role="alert">{t(errors[key])}</small>;
  const mine = state.items.filter((item) => item.owner_id === user?.id);
  const forMe = state.items.filter((item) => item.owner_id !== user?.id);

  function row(item) {
    const own = item.owner_id === user?.id;
    const target = item.target_id !== user?.id ? clientName.get(item.target_id) || t('rmClientWord') : null;
    return (
      <article className={`reminder-row ${item.is_active ? '' : 'is-off'}`} key={item.id}>
        <span className="reminder-icon" aria-hidden="true">{REMINDER_KIND_ICONS[item.kind]}</span>
        <div className="reminder-copy">
          <strong dir="auto">{item.title}</strong>
          {item.message && <small className="muted-copy" dir="auto">{item.message}</small>}
          <small className="muted-copy" dir="auto">
            {formatReminderTime(item.time_of_day, locale)} · {describeDays(item.days_of_week, locale, t)}
            {target ? ` · ${t('rmFor')} ${target}` : ''}
          </small>
        </div>
        {own && (
          <div className="meal-plan-row-actions">
            <label className="checkbox-row"><input type="checkbox" checked={item.is_active} disabled={busy} onChange={(event) => setActive(item, event.target.checked)} />{t('rmActive')}</label>
            <button className="text-action" type="button" disabled={busy} onClick={() => { setNotice(null); setErrors({}); setForm(reminderToForm(item, user?.id)); }}>{t('mpEdit')}</button>
            <button className="text-action rpt-delete" type="button" disabled={busy} onClick={() => remove(item)}>{t('mpDelete')}</button>
          </div>
        )}
      </article>
    );
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('rmTitle')} description={t('rmDescription')} action={<Button variant="primary" disabled={mine.length >= REMINDER_LIMIT} onClick={startNew}>{t('rmNew')}</Button>} />
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('rmLoadError')} {state.error}</div>}

      {form && (
        <form className="panel reminder-form" onSubmit={save} noValidate>
          <div className="panel-heading"><div><span className="eyebrow">{t('rmTitle')}</span><h3>{form.id ? t('rmEdit') : t('rmNew')}</h3></div></div>
          <div className="recipe-editor-grid">
            <label className="form-label">{t('rmKind')}
              <select className="field" value={form.kind} onChange={(event) => changeKind(event.target.value)}>
                {REMINDER_KINDS.map((kind) => <option key={kind} value={kind}>{REMINDER_KIND_ICONS[kind]} {t(REMINDER_KIND_KEYS[kind])}</option>)}
              </select>
            </label>
            <label className="form-label">{t('rmTime')}
              <input className="field" type="time" value={form.time} onChange={(event) => update({ time: event.target.value })} aria-invalid={Boolean(errors.time)} dir="ltr" />
              {fieldError('time')}
            </label>
            {isCoach && state.clients.length > 0 && (
              <label className="form-label">{t('rmRemind')}
                <select className="field" value={form.target} onChange={(event) => update({ target: event.target.value })}>
                  <option value="">{t('rmMyself')}</option>
                  {state.clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
                </select>
              </label>
            )}
          </div>
          <label className="form-label">{t('rmName')}
            <input className="field" value={form.title} maxLength={REMINDER_TITLE_MAX} onChange={(event) => update({ title: event.target.value })} aria-invalid={Boolean(errors.title)} dir="auto" />
            {fieldError('title')}
          </label>
          <label className="form-label">{t('rmMessage')}
            <textarea className="field" rows={2} maxLength={REMINDER_MESSAGE_MAX} value={form.message} placeholder={t('rmMessagePlaceholder')} onChange={(event) => update({ message: event.target.value })} dir="auto" />
            {fieldError('message')}
          </label>
          <fieldset className="reminder-days">
            <legend>{t('rmDays')}</legend>
            <div className="reminder-day-list">
              {ALL_DAYS.map((day) => (
                <button key={day} type="button" className={`choice-chip ${form.days.includes(day) ? 'is-selected' : ''}`} aria-pressed={form.days.includes(day)} onClick={() => update({ days: toggleDay(form.days, day) })}>
                  {weekdayLabel(day, locale)}
                </button>
              ))}
            </div>
            {fieldError('days')}
          </fieldset>
          <label className="checkbox-row"><input type="checkbox" checked={form.active} onChange={(event) => update({ active: event.target.checked })} />{t('rmActive')}</label>
          <small className="muted-copy" dir="ltr">{t('rmTimezone')}: {timezone}</small>
          <div className="habit-modal-actions">
            <Button variant="secondary" type="button" onClick={() => setForm(null)}>{t('hbCancel')}</Button>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? t('hbSaving') : t('rmSave')}</Button>
          </div>
        </form>
      )}

      {state.status === 'ready' && (
        <div className="reminder-lists">
          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('rmTitle')}</span><h3>{t('rmMine')}</h3></div></div>
            {mine.length === 0 && <div className="empty-state">{t('rmEmpty')}</div>}
            {mine.map(row)}
          </section>
          {forMe.length > 0 && (
            <section className="panel">
              <div className="panel-heading"><div><span className="eyebrow">{t('rmTitle')}</span><h3>{t('rmFromCoach')}</h3></div></div>
              {forMe.map(row)}
            </section>
          )}
        </div>
      )}
      <PushPanel />
    </>
  );
}
