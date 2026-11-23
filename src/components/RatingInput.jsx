// A row of numbered buttons (1 to max) for a rating, usable with the keyboard and by screen readers.
export default function RatingInput({ label, value, max, onChange, invalid = false }) {
  return (
    <div className={`rating-input ${invalid ? 'is-invalid' : ''}`} role="radiogroup" aria-label={label}>
      {Array.from({ length: max }, (_, index) => index + 1).map((number) => (
        <button
          key={number}
          type="button"
          role="radio"
          aria-checked={value === number}
          className={`rating-option ${value === number ? 'is-selected' : ''}`}
          onClick={() => onChange(number)}
        >
          {number}
        </button>
      ))}
    </div>
  );
}