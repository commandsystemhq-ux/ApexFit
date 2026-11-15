export default function StatCard({ label, value, change, icon }) {
  return (
    <article className="stat-card">
      <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon">{icon}</span></div>
      <strong className="stat-value">{value}</strong>
      <span className="stat-change">{change}</span>
    </article>
  );
}
