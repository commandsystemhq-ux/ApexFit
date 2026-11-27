export default function ClientTagBadge({ tag, onClick, selected = false, count }) {
  const className = `client-tag tag-color-${tag.color} ${tag.kind === 'type' ? 'is-type' : ''} ${selected ? 'is-selected' : ''}`;
  const content = (
    <>
      {tag.kind === 'type' && <span aria-hidden="true">◆ </span>}
      <span dir="auto">{tag.name}</span>
      {count !== undefined && <small dir="ltr"> {count}</small>}
    </>
  );
  if (!onClick) return <span className={className}>{content}</span>;
  return <button type="button" className={className} aria-pressed={selected} onClick={onClick}>{content}</button>;
}
