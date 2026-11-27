import { useState } from 'react';
import ProgramDaysView from './ProgramDaysView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getWorkoutProgram } from '../services/workoutProgramService.js';

// "See exercises and tempo" on a template card: the program is fetched when the section is first opened.
export default function ProgramPreview({ programId }) {
  const { t } = useLocale();
  const [state, setState] = useState({ status: 'idle', program: null, error: '' });

  function onToggle(event) {
    if (!event.currentTarget.open || state.status !== 'idle') return;
    setState({ status: 'loading', program: null, error: '' });
    getWorkoutProgram(programId)
      .then((program) => setState({ status: 'ready', program, error: '' }))
      .catch((error) => setState({ status: 'error', program: null, error: error.message }));
  }

  return (
    <details className="program-preview" onToggle={onToggle}>
      <summary>{t('tpTemplatePreview')}</summary>
      {state.status === 'loading' && <p className="muted-copy" role="status">{t('tpLoading')}</p>}
      {state.status === 'error' && <div className="notice notice-error" role="alert">{t('tpLoadError')} {state.error}</div>}
      {state.program && <ProgramDaysView days={state.program.days} />}
    </details>
  );
}
