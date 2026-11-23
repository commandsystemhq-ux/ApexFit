import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import ClientFoodLogger from '../components/ClientFoodLogger.jsx';
import ClientMealPlan from '../components/ClientMealPlan.jsx';
import NutritionTracker from '../components/NutritionTracker.jsx';
import ClientHabitTracker from '../components/ClientHabitTracker.jsx';
import ClientIntakeForm from '../components/ClientIntakeForm.jsx';
import ClientOneRepMax from '../components/ClientOneRepMax.jsx';
import ClientProgressTracking from '../components/ClientProgressTracking.jsx';
import ClientWorkoutLogger from '../components/ClientWorkoutLogger.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMyIntakeForm } from '../services/clientIntakeService.js';
import { PAGES } from '../routes.js';

const SECTION_IDS = ['workouts', 'progress', 'strength', 'food', 'habits', 'intake'];

// A client without an intake form is sent there once per browser session, not on every navigation.
let intakePromptShown = false;

export default function ClientPortalPage({ section }) {
  const { t } = useLocale();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [intakeMissing, setIntakeMissing] = useState(false);
  const [foodVersion, setFoodVersion] = useState(0);

  useEffect(() => {
    let active = true;
    getMyIntakeForm()
      .then((row) => {
        if (!active || row) return;
        setIntakeMissing(true);
        if (!intakePromptShown) {
          intakePromptShown = true;
          navigate(PAGES.intake.path, { replace: true });
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [user?.id]);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t(PAGES[section].titleKey)} description={t('clientTrackingDescription')} />
      <nav className="client-feature-tabs portal-tabs" aria-label={t('portalTitle')}>
        {SECTION_IDS.map((id) => (
          <NavLink key={id} to={PAGES[id].path} className={({ isActive }) => `client-feature-tab ${isActive ? 'is-active' : ''}`}>
            <span aria-hidden="true">{PAGES[id].icon}</span>{t(PAGES[id].titleKey)}
          </NavLink>
        ))}
      </nav>
      {intakeMissing && section !== 'intake' && <div className="notice notice-info" role="status">{t('intakeCompleteNotice')}</div>}
      {section === 'workouts' && <ClientWorkoutLogger />}
      {section === 'progress' && <ClientProgressTracking clientId={user.id} />}
      {section === 'strength' && <ClientOneRepMax />}
      {section === 'food' && <ClientMealPlan onLogged={() => setFoodVersion((version) => version + 1)} />}
      {section === 'food' && <ClientFoodLogger key={foodVersion} />}
      {section === 'food' && (
        <section className="nutrition-section" aria-labelledby="nutrition-section-title">
          <h3 id="nutrition-section-title" className="contract-section-title">{t('nutSectionTitle')}</h3>
          <NutritionTracker />
        </section>
      )}
      {section === 'habits' && <ClientHabitTracker />}
      {section === 'intake' && <ClientIntakeForm onCompleted={() => setIntakeMissing(false)} />}
    </>
  );
}
