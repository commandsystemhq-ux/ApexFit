import { useCallback, useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { deleteMessageTemplate, listMessageTemplates, saveMessageTemplate } from '../services/messageTemplateService.js';
import {
  CLIENT_NAME_PLACEHOLDER, TEMPLATE_BODY_MAX, TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_KEYS, TEMPLATE_LIMIT, TEMPLATE_TITLE_MAX,
  emptyTemplateForm, groupTemplates, starterPayloads, validateTemplate,
} from '../services/messageTemplateUtils.js';

// The coach's saved messages: write, edit and delete them, or add the starter set (welcome, encouragement, check-in
// reminder, diet change) in the current language.
export default function MessageTemplatesManager() {
  const { t } = useLocale();
  const [state, setState] = useState({ status: 'loading', items: [], error: '' });
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: await listMessageTemplates(), error: '' });
    } catch (error) {
      setState({ status: 'error', items: [], error: error.message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const say = (kind, text) => setNotice({ kind, text });
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  async function save(event) {
    event.preventDefault();
    const result = validateTemplate(form);
    setErrors(result.errors);
    if (!result.valid) return;
    setBusy(true);
    setNotice(null);
    try {
      await saveMessageTemplate({ id: form.id, ...result.payload });
      setForm(null);
      await load();
      say('info', t('tplSaved'));
    } catch (error) {
      say('error', `${t('tplActionError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    if (!window.confirm(t('tplDeleteConfirm'))) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteMessageTemplate(item.id);
      await load();
      say('info', t('tplDeleted'));
    } catch (error) {
      say('error', `${t('tplActionError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function addStarters() {
    const payloads = starterPayloads(t, state.items.map((item) => item.title));
    if (payloads.length === 0) {
      say('info', t('tplStartersAlready'));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      for (const payload of payloads) await saveMessageTemplate(payload);
      await load();
      say('info', t('tplStartersAdded'));
    } catch (error) {
      await load();
      say('error', `${t('tplActionError')} ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const groups = groupTemplates(state.items);
  const fieldError = (key) => errors[key] && <small className="field-error" role="alert">{t(errors[key])}</small>;

  return (
    <section className="panel template-manager">
      <div className="panel-heading">
        <div><span className="eyebrow">{t('messages')}</span><h3>{t('tplTitle')}</h3></div>
        <div className="page-heading-action">
          <Button variant="secondary" size="small" type="button" disabled={busy || state.status !== 'ready'} onClick={addStarters}>{t('tplAddStarters')}</Button>
          <Button variant="primary" size="small" type="button" disabled={state.items.length >= TEMPLATE_LIMIT} onClick={() => { setNotice(null); setErrors({}); setForm(emptyTemplateForm()); }}>{t('tplNew')}</Button>
        </div>
      </div>
      <p className="muted-copy">{t('tplHelp')} <code dir="ltr">{CLIENT_NAME_PLACEHOLDER}</code></p>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
      {state.status === 'loading' && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('tplLoadError')} {state.error}</div>}

      {form && (
        <form className="template-form" onSubmit={save} noValidate>
          <label className="form-label">{t('tplName')}
            <input className="field" value={form.title} maxLength={TEMPLATE_TITLE_MAX} onChange={(event) => update({ title: event.target.value })} aria-invalid={Boolean(errors.title)} dir="auto" />
            {fieldError('title')}
          </label>
          <label className="form-label">{t('tplCategory')}
            <select className="field" value={form.category} onChange={(event) => update({ category: event.target.value })}>
              {TEMPLATE_CATEGORIES.map((category) => <option key={category} value={category}>{t(TEMPLATE_CATEGORY_KEYS[category])}</option>)}
            </select>
          </label>
          <label className="form-label">{t('tplBody')}
            <textarea className="field intake-textarea" rows={4} maxLength={TEMPLATE_BODY_MAX} value={form.body} placeholder={t('tplBodyPlaceholder')} onChange={(event) => update({ body: event.target.value })} aria-invalid={Boolean(errors.body)} dir="auto" />
            {fieldError('body')}
          </label>
          <div className="habit-modal-actions">
            <Button variant="secondary" type="button" onClick={() => setForm(null)}>{t('hbCancel')}</Button>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? t('hbSaving') : t('tplSave')}</Button>
          </div>
        </form>
      )}

      {state.status === 'ready' && state.items.length === 0 && !form && <div className="empty-state">{t('tplNoneYet')}</div>}
      {groups.map((group) => (
        <div className="template-group" key={group.category}>
          <span className="template-group-title">{t(TEMPLATE_CATEGORY_KEYS[group.category])}</span>
          {group.items.map((item) => (
            <article className="template-row" key={item.id}>
              <div><strong dir="auto">{item.title}</strong><p className="muted-copy" dir="auto">{item.body}</p></div>
              <div className="meal-plan-row-actions">
                <button className="text-action" type="button" disabled={busy} onClick={() => { setNotice(null); setErrors({}); setForm({ id: item.id, title: item.title, category: item.category, body: item.body }); }}>{t('tplEdit')}</button>
                <button className="text-action rpt-delete" type="button" disabled={busy} onClick={() => remove(item)}>{t('tplDelete')}</button>
              </div>
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}
