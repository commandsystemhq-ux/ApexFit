import { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMyGroups } from '../services/groupService.js';

export default function ClientGroupsPage() {
  const { t, locale } = useLocale();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getMyGroups()
      .then((rows) => {
        if (active) setGroups(rows);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('grpMyTitle')} description={t('grpMyDescription')} />
      {error && <div className="notice notice-error" role="alert">{t('grpMyLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && groups.length === 0 && (
        <section className="panel"><div className="dashboard-empty"><h3>{t('grpMyEmpty')}</h3><p>{t('grpMyEmptyHelp')}</p></div></section>
      )}

      <div className="contract-list">
        {groups.map((group) => (
          <article className="panel group-card" key={group.id}>
            <div className="template-card-heading">
              <h3>{group.name}</h3>
              <span className="soft-badge badge-blue">{group.member_count} {t('grpMembersCount')}</span>
            </div>
            {group.description && <p className="muted-copy">{group.description}</p>}
            {group.coach_name && <small className="muted-copy">{t('grpCoach')}: {group.coach_name}</small>}

            <h4 className="group-subheading">{t('grpSharedProgram')}{group.program ? `: ${group.program.title}` : ''}</h4>
            {!group.program && <p className="muted-copy">{t('grpNoSharedProgram')}</p>}
            {group.program && (
              <ol className="group-program-days">
                {group.program.days.map((day, index) => (
                  <li key={`${day.name}-${index}`}>
                    <strong>{day.name}</strong>
                    <ul>
                      {day.exercises.map((exercise, exerciseIndex) => (
                        <li key={`${exercise.name}-${exerciseIndex}`}><span>{exercise.name}</span><small dir="ltr">{exercise.sets} × {exercise.reps}</small></li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}

            <h4 className="group-subheading">{t('grpUpdates')}</h4>
            {group.announcements.length === 0 && <p className="muted-copy">{t('grpNoUpdates')}</p>}
            <ul className="group-feed">
              {group.announcements.map((item) => (
                <li key={item.id}>
                  <p dir="auto">{item.body}</p>
                  <div className="group-feed-meta"><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString(locale)}</time></div>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </>
  );
}
