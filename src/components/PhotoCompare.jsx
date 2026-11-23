import { useMemo, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useSignedPhotos } from '../hooks/useSignedPhotos.js';
import { PHOTO_SLOTS, defaultComparison, weeksWithPhoto } from '../services/checkinUtils.js';

// Two weeks of one client side by side, for one view (front, side or back). The coach picks any two weeks.
export default function PhotoCompare({ checkins }) {
  const { t, locale } = useLocale();
  const [slot, setSlot] = useState('front');
  const [choice, setChoice] = useState(null);
  const weeks = useMemo(() => weeksWithPhoto(checkins, slot), [checkins, slot]);
  const picked = useMemo(() => {
    const fallback = defaultComparison(checkins, slot);
    const valid = (id) => weeks.some((week) => week.id === id);
    return { left: valid(choice?.left) ? choice.left : fallback.left, right: valid(choice?.right) ? choice.right : fallback.right };
  }, [checkins, slot, weeks, choice]);
  const left = weeks.find((week) => week.id === picked.left);
  const right = weeks.find((week) => week.id === picked.right);
  const photos = useSignedPhotos([left?.photo_paths?.[slot], right?.photo_paths?.[slot]]);
  const label = (week) => new Date(`${week.week_start_date}T12:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });

  const renderSide = (week, field, title) => (
      <figure className="compare-side">
        <label className="form-label">{title}
          <select className="field" value={week?.id || ''} onChange={(event) => setChoice({ ...picked, [field]: event.target.value })}>
            {weeks.map((option) => <option key={option.id} value={option.id}>{label(option)}</option>)}
          </select>
        </label>
        {week && photos.urls[week.photo_paths[slot]]
          ? <img src={photos.urls[week.photo_paths[slot]]} alt={`${t(`ckSlot_${slot}`)} ${label(week)}`} />
          : <div className="checkin-photo-placeholder">{week ? t('ckPhotoLoading') : '\u2014'}</div>}
      </figure>
  );

  return (
    <section className="photo-compare" aria-label={t('ckCompareTitle')}>
      <div className="panel-heading"><div><span className="eyebrow">{t('ckCompareTitle')}</span></div></div>
      <p className="muted-copy">{t('ckCompareHelp')}</p>
      <div className="food-review-range" role="group" aria-label={t('ckCompareSlot')}>
        {PHOTO_SLOTS.map((name) => (
          <button key={name} type="button" className={`choice-chip ${slot === name ? 'is-selected' : ''}`} aria-pressed={slot === name} onClick={() => setSlot(name)}>{t(`ckSlot_${name}`)}</button>
        ))}
      </div>
      {weeks.length < 2 ? (
        <div className="empty-state">{t('ckCompareNeedTwo')}</div>
      ) : (
        <div className="compare-grid">
          {renderSide(left, 'left', t('ckCompareLeft'))}
          {renderSide(right, 'right', t('ckCompareRight'))}
        </div>
      )}
    </section>
  );
}