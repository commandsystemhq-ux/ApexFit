import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../components/Button.jsx';
import CoachCard from '../components/CoachCard.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { announceNotificationsChanged } from '../services/notificationService.js';
import { cancelContactRequest, listMyContactRequests, searchCoaches } from '../services/marketplaceService.js';
import {
  MARKETPLACE_LANGUAGES, REQUEST_STATUS_KEYS, SEARCH_PAGE_SIZE, TRAINING_MODES, TRAINING_MODE_KEYS, coachPath, countryOptions, emptyFilters, hasActiveFilters,
  languageName, pageCount, specialtyChoices,
} from '../services/marketplaceUtils.js';
import { fillTemplate } from '../services/textTemplate.js';

function MyRequests() {
  const { t } = useLocale();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => listMyContactRequests().then(setItems).catch((loadError) => setError(loadError.message)), []);
  useEffect(() => { load(); }, [load]);

  async function cancel(id) {
    try {
      await cancelContactRequest(id);
      announceNotificationsChanged();
      await load();
    } catch (cancelError) {
      setError(cancelError.message);
    }
  }

  if (items === null && !error) return null;
  return (
    <section className="panel mk-requests">
      <div className="panel-heading"><div><span className="eyebrow">{t('mkCoachesTitle')}</span><h3>{t('mkMyRequests')}</h3></div></div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {items?.length === 0 && <p className="muted-copy">{t('mkNoRequests')}</p>}
      {(items || []).map((item) => (
        <article className="mk-request-row" key={item.id}>
          <div>
            <Link to={coachPath(item.coach_id)}><strong dir="auto">{item.coach_name || t('mkSomeone')}</strong></Link>
            <small className="muted-copy" dir="auto">{item.message}</small>
          </div>
          <span className={`soft-badge ${item.status === 'accepted' ? 'badge-green' : item.status === 'pending' ? 'badge-amber' : 'badge-muted'}`}>{t(REQUEST_STATUS_KEYS[item.status])}</span>
          {item.status === 'pending' && <button className="text-action" type="button" onClick={() => cancel(item.id)}>{t('mkCancelRequest')}</button>}
        </article>
      ))}
    </section>
  );
}

// The coaches marketplace for a client: text search and filters over the coaches who are listed, active and not hidden.
export default function CoachesPage() {
  const { t, locale } = useLocale();
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [page, setPage] = useState(0);
  const [state, setState] = useState({ status: 'loading', items: [], total: 0, error: '' });
  const [knownSpecialties, setKnownSpecialties] = useState([]);
  const countries = useMemo(() => countryOptions(locale), [locale]);

  // Typing waits a moment before searching; the other filters apply at once.
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(filters); setPage(0); }, 300);
    return () => clearTimeout(timer);
  }, [filters]);

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, status: 'loading' }));
    searchCoaches(applied, page)
      .then((result) => {
        if (!active) return;
        setState({ status: 'ready', items: result.items || [], total: result.total || 0, error: '' });
        setKnownSpecialties((current) => specialtyChoices([{ specialties: current }, ...(result.items || [])]));
      })
      .catch((error) => { if (active) setState({ status: 'error', items: [], total: 0, error: error.message }); });
    return () => { active = false; };
  }, [applied, page]);

  const update = (patch) => setFilters((current) => ({ ...current, ...patch }));
  const pages = pageCount(state.total);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('mkCoachesTitle')} description={t('mkCoachesDescription')} />
      <section className="panel mk-filters">
        <input className="field mk-search" type="search" value={filters.query} placeholder={t('mkSearchPlaceholder')} aria-label={t('mkSearchPlaceholder')} onChange={(event) => update({ query: event.target.value })} dir="auto" />
        <div className="mk-filter-grid">
          <label className="form-label">{t('mkFilterSpecialty')}
            <input className="field" list="mk-specialty-options" value={filters.specialty} placeholder={t('mkFilterAnySpecialty')} onChange={(event) => update({ specialty: event.target.value })} dir="auto" />
            <datalist id="mk-specialty-options">{knownSpecialties.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          <label className="form-label">{t('mkFilterLanguage')}
            <select className="field" value={filters.language} onChange={(event) => update({ language: event.target.value })}>
              <option value="">{t('mkFilterAnyLanguage')}</option>
              {MARKETPLACE_LANGUAGES.map((code) => <option key={code} value={code}>{languageName(code, locale)}</option>)}
            </select>
          </label>
          <label className="form-label">{t('mkFilterCountry')}
            <select className="field" value={filters.country} onChange={(event) => update({ country: event.target.value })}>
              <option value="">{t('mkFilterAnyCountry')}</option>
              {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
            </select>
          </label>
          <label className="form-label">{t('mkFilterCity')}
            <input className="field" value={filters.city} onChange={(event) => update({ city: event.target.value })} dir="auto" />
          </label>
          <label className="form-label">{t('mkFilterMode')}
            <select className="field" value={filters.mode} onChange={(event) => update({ mode: event.target.value })}>
              <option value="">{t('mkFilterAnyMode')}</option>
              {TRAINING_MODES.filter((mode) => mode !== 'both').map((mode) => <option key={mode} value={mode}>{t(TRAINING_MODE_KEYS[mode])}</option>)}
            </select>
          </label>
          <label className="form-label">{t('mkFilterRating')}
            <select className="field" value={filters.minRating} onChange={(event) => update({ minRating: event.target.value })}>
              <option value="">{t('mkFilterAnyRating')}</option>
              {[4, 3, 2].map((stars) => <option key={stars} value={stars}>{fillTemplate(t('mkRatingAtLeast'), { stars })}</option>)}
            </select>
          </label>
        </div>
        <div className="mk-filter-foot">
          <label className="checkbox-row"><input type="checkbox" checked={filters.acceptingOnly} onChange={(event) => update({ acceptingOnly: event.target.checked })} />{t('mkFilterAccepting')}</label>
          {hasActiveFilters(filters) && <button className="text-action" type="button" onClick={() => setFilters(emptyFilters())}>{t('mkClearFilters')}</button>}
        </div>
      </section>

      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('mkLoadError')} {state.error}</div>}
      {state.status === 'loading' && <div className="empty-state" role="status">{t('mkLoading')}</div>}
      {state.status === 'ready' && (
        <>
          <p className="muted-copy mk-count" role="status">{fillTemplate(t('mkResults'), { count: state.total })}</p>
          {state.items.length === 0 && <div className="empty-state">{t('mkNoResults')}</div>}
          <div className="mk-grid">{state.items.map((coach) => <CoachCard key={coach.coach_id} coach={coach} />)}</div>
          {state.total > SEARCH_PAGE_SIZE && (
            <div className="mk-pager">
              <Button variant="secondary" size="small" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>{t('mkPrev')}</Button>
              <span className="muted-copy">{fillTemplate(t('mkPageOf'), { page: page + 1, total: pages })}</span>
              <Button variant="secondary" size="small" disabled={page + 1 >= pages} onClick={() => setPage((current) => current + 1)}>{t('mkNext')}</Button>
            </div>
          )}
        </>
      )}
      <MyRequests />
    </>
  );
}
