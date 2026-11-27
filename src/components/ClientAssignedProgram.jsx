import { useEffect, useState } from 'react';
import ProgramDaysView, { TempoHelp } from './ProgramDaysView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyAssignedPrograms } from '../services/workoutProgramService.js';

// The programs the coach assigned to the client, shown above the workout log with the tempo of every exercise.
export default function ClientAssignedProgram() {
  const { t, locale } = useLocale();
  const [state, setState] = useState({ status: 'loading', programs: [], error: '' });

  useEffect(() => {
    let active = true;
    listMyAssignedPrograms()
      .then((programs) => active && setState({ status: 'ready', programs, error: '' }))
      .catch((error) => active && setState({ status: 'error', programs: [], error: error.message }));
    return () => { active = false; };
  }, []);

  if (state.status === 'ready' && state.programs.length === 0) return null;

  return (
    <section className="panel client-assigned-program">
      <div className="panel-heading"><div><span className="eyebrow">{t('workoutLog')}</span><h3>{t('tpMyProgram')}</h3></div></div>
      <p className="muted-copy">{t('tpMyProgramHint')}</p>
      {state.status === 'loading' && <div className="empty-state" role="status">{t('tpLoading')}</div>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('tpProgramError')} {state.error}</div>}
      {state.programs.map((program) => (
        <article className="assigned-program" key={program.program_id}>
          <div className="client-history-heading">
            <strong dir="auto">{program.title}</strong>
            <time dateTime={program.assigned_at}>{t('tpAssignedOn')} {new Date(program.assigned_at).toLocaleDateString(locale)}</time>
          </div>
          {program.description && <p className="muted-copy" dir="auto">{program.description}</p>}
          <ProgramDaysView days={program.days} />
        </article>
      ))}
      {state.programs.length > 0 && <TempoHelp />}
    </section>
  );
}
