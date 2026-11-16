import { useId } from 'react';

// Neon "spark" mark that matches the ApexFit blue-to-cyan emblem.
export default function JackIcon({ size = 26 }) {
  const id = `jack-gradient-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1c5dff" />
          <stop offset="1" stopColor="#12e0f0" />
        </linearGradient>
      </defs>
      <path d="M16 3.5l2.6 7.4 7.4 2.6-7.4 2.6L16 23.5l-2.6-7.4L6 13.5l7.4-2.6L16 3.5z" fill={`url(#${id})`} />
      <path d="M25.5 20.5l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9-2.9-1.1 2.9-1.1 1.1-2.9z" fill={`url(#${id})`} opacity=".85" />
      <circle cx="6.5" cy="7" r="1.6" fill={`url(#${id})`} opacity=".7" />
    </svg>
  );
}