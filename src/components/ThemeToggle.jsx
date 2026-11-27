import { useLocale } from '../contexts/LocaleContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';
import { THEME_MODES } from '../services/themeUtils.js';

const ICONS = { dark: '\u263E', light: '\u2600', system: '\u25D0' };
const LABEL_KEYS = { dark: 'themeDark', light: 'themeLight', system: 'themeSystem' };

// Dark / Light / System. `compact` shows only the icons (top bar); the default also shows the names (settings).
export default function ThemeToggle({ compact = false }) {
  const { t } = useLocale();
  const { mode, setMode } = useTheme();
  return (
    <div className={`theme-toggle ${compact ? 'is-compact' : ''}`} role="radiogroup" aria-label={t('themeLabel')}>
      {THEME_MODES.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={mode === id}
          className={`theme-option ${mode === id ? 'is-selected' : ''}`}
          title={t(LABEL_KEYS[id])}
          aria-label={compact ? t(LABEL_KEYS[id]) : undefined}
          onClick={() => setMode(id)}
        >
          <span aria-hidden="true">{ICONS[id]}</span>
          {!compact && <span>{t(LABEL_KEYS[id])}</span>}
        </button>
      ))}
    </div>
  );
}
