import { useLocale } from '../contexts/LocaleContext.jsx';
import { useExerciseBundle } from '../hooks/useExerciseBundle.js';
import { displayName } from '../services/exerciseI18n.js';
import { describeTempo, normalizeTempo, tempoParts } from '../services/tempoUtils.js';

export function TempoBadge({ tempo }) {
  const { t } = useLocale();
  if (!tempoParts(tempo)) return null;
  return (
    <span className="tempo-badge" title={describeTempo(tempo, t)}>
      {t('tpLabel')} <bdi dir="ltr">{normalizeTempo(tempo)}</bdi>
    </span>
  );
}

export function TempoHelp() {
  const { t } = useLocale();
  return (
    <details className="tempo-help">
      <summary>{t('tpHelpTitle')}</summary>
      <p>{t('tpHelp')}</p>
    </details>
  );
}

// The days of a program with, for each exercise, sets x reps, rest, tempo (with its meaning) and the coach's notes.
export default function ProgramDaysView({ days }) {
  const { t, locale } = useLocale();
  const bundle = useExerciseBundle(locale);
  return (
    <div className="program-days">
      {days.map((day) => (
        <section className="program-day" key={day.id}>
          <h4 dir="auto">{day.name}</h4>
          <ol className="program-exercise-list">
            {day.exercises.map((item) => (
              <li key={item.id} className="program-exercise">
                <strong dir="auto">{item.exercise ? displayName(item.exercise, locale, bundle) : t('unavailableExercise')}</strong>
                <span className="program-exercise-meta">
                  <bdi dir="ltr">{item.sets} × {item.reps}</bdi>
                  <span>{t('tpRest')} <bdi dir="ltr">{item.rest_seconds}s</bdi></span>
                  <TempoBadge tempo={item.tempo} />
                </span>
                {tempoParts(item.tempo) && <small className="muted-copy tempo-meaning">{describeTempo(item.tempo, t)}</small>}
                {item.notes && <small className="muted-copy" dir="auto">{t('tpNotes')}: {item.notes}</small>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
