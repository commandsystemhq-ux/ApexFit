import { formatRating, starStates } from '../services/marketplaceUtils.js';

const GLYPHS = { full: '\u2605', half: '\u2605', empty: '\u2606' };

// Read-only stars for a rating from 0 to 5, with the number and the count next to them.
export default function RatingStars({ value, count = null, label }) {
  const states = starStates(value);
  return (
    <span className="mk-stars" role="img" aria-label={`${label || ''} ${formatRating(value)} / 5`.trim()}>
      <span className="mk-star-row" aria-hidden="true">
        {states.map((state, index) => <span key={index} className={`mk-star is-${state}`}>{GLYPHS[state]}</span>)}
      </span>
      <strong aria-hidden="true">{formatRating(value)}</strong>
      {count !== null && <small aria-hidden="true">({count})</small>}
    </span>
  );
}
