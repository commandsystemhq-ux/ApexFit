import { useId } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useRamadanMode } from '../hooks/useRamadanMode.js';

// A switch that adds "before iftar", "iftar" and "suhoor" to the meals offered on this screen.
export default function RamadanToggle() {
  const { t } = useLocale();
  const id = useId();
  const [on, setOn] = useRamadanMode();
  return (
    <label className="ramadan-toggle" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={on} onChange={(event) => setOn(event.target.checked)} />
      <span><strong>{t('ramadanMeals')}</strong><small>{t('ramadanMealsHint')}</small></span>
    </label>
  );
}