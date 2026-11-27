import ClientTagBadge from './ClientTagBadge.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { fillText } from '../services/accountabilityUtils.js';

// Quick search and filters above the client list: words (name, e-mail, tag), one type, and any number of tags.
export default function ClientTagFilters({ tags, counts, filters, onChange, shown, total }) {
  const { t } = useLocale();
  const types = tags.filter((tag) => tag.kind === 'type');
  const plain = tags.filter((tag) => tag.kind === 'tag');
  const active = Boolean(filters.query || filters.typeId || filters.tagIds.length);

  const toggleTag = (id) => onChange({ ...filters, tagIds: filters.tagIds.includes(id) ? filters.tagIds.filter((item) => item !== id) : [...filters.tagIds, id] });

  return (
    <div className="client-filters">
      <div className="client-filter-row">
        <input className="field" type="search" value={filters.query} placeholder={t('tgFilterSearch')} aria-label={t('tgFilterSearch')} onChange={(event) => onChange({ ...filters, query: event.target.value })} />
        {types.length > 0 && (
          <select className="field" value={filters.typeId} aria-label={t('tgFilterType')} onChange={(event) => onChange({ ...filters, typeId: event.target.value })}>
            <option value="">{t('tgFilterAllTypes')}</option>
            {types.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}{counts.get(tag.id) ? ` (${counts.get(tag.id)})` : ''}</option>)}
          </select>
        )}
      </div>
      {plain.length > 0 && (
        <div className="client-tag-row" role="group" aria-label={t('tgFilterTags')}>
          {plain.map((tag) => <ClientTagBadge key={tag.id} tag={tag} count={counts.get(tag.id) || 0} selected={filters.tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)} />)}
        </div>
      )}
      {(active || shown !== total) && (
        <div className="client-filter-summary" role="status">
          <span>{fillText(t('tgShowing'), { n: shown, m: total })}</span>
          {active && <button type="button" className="text-action" onClick={() => onChange({ query: '', typeId: '', tagIds: [] })}>{t('tgClear')}</button>}
        </div>
      )}
    </div>
  );
}
