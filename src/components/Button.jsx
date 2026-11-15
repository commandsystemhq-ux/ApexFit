export default function Button({ variant = 'secondary', size = '', className = '', children, ...props }) {
  return (
    <button className={`button button-${variant} ${size ? `button-${size}` : ''} ${className}`} {...props}>
      {children}
    </button>
  );
}
