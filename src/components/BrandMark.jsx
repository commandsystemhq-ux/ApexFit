export default function BrandMark({ compact = false }) {
  return (
    <img className={`brand-logo ${compact ? 'brand-logo-compact' : ''}`} src="/apexfit-logo.png" alt="ApexFit" />
  );
}
