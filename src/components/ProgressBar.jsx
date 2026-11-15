export default function ProgressBar({ value, color = 'blue' }) {
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={value} aria-valuemin="0" aria-valuemax="100">
      <span className={`progress-value progress-${color}`} style={{ width: `${value}%` }} />
    </div>
  );
}
