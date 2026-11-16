import { Fragment, Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import BrandMark from './BrandMark.jsx';
import Button from './Button.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import OnboardingNotice from './OnboardingNotice.jsx';
import TeamInvitationNotice from './TeamInvitationNotice.jsx';
import UserAvatar from './UserAvatar.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { displayNameFor } from '../services/profileUtils.js';
import { PAGES, homePathFor, navigationFor, pageForPath, roleOf } from '../routes.js';

const JackFloatingWidget = lazy(() => import('./JackFloatingWidget.jsx'));

export default function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const { t } = useLocale();
  const { user, profile, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const role = roleOf(profile);
  const sections = navigationFor(role);
  const page = pageForPath(location.pathname);

  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <div className={`sidebar-backdrop ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <button className="sidebar-brand" onClick={() => navigate(homePathFor(role))} aria-label={`ApexFit ${t('home')}`}><BrandMark /></button>
        <nav className="side-nav" aria-label={t('main')}>
          {sections.map((section) => (
            <div className="nav-section" key={section.group}>
              <span className="nav-heading">{t(section.group)}</span>
              {section.items.map((id) => (
                <NavLink key={id} to={PAGES[id].path} className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}>
                  <span className="nav-icon" aria-hidden="true">{PAGES[id].icon}</span>
                  <span>{t(PAGES[id].titleKey)}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <NavLink className="sidebar-profile" to={PAGES.settings.path} aria-label={t('settings')}>
          <UserAvatar user={user} profile={profile} />
          <div className="profile-copy">
            <strong>{displayNameFor(profile, user) || t('signedOut')}</strong>
            <span>{profile ? t(profile.role) : t('account')}</span>
          </div>
        </NavLink>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title-wrap">
            <button className="menu-toggle" onClick={() => setMenuOpen(true)} aria-label={t('openNavigation')}>☰</button>
            <h1 className="topbar-title">{t(page?.titleKey || 'dashboard')}</h1>
          </div>
          <div className="topbar-actions">
            <LanguageToggle />
            <Button variant="secondary" size="small" onClick={signOut}>{t('signOut')}</Button>
            {role === 'coach' && <Button variant="primary" size="small" onClick={() => navigate(PAGES.generator.path)}>{t('createPlan')}</Button>}
          </div>
        </header>
        <div className="page-content">
          <OnboardingNotice />
          <TeamInvitationNotice />
          <Suspense fallback={<div className="empty-state" role="status">{t('loadingProgress')}</div>}>
            <Fragment key={dataVersion}><Outlet /></Fragment>
          </Suspense>
        </div>
      </main>
      <Suspense fallback={null}>
        <JackFloatingWidget onDataChanged={() => setDataVersion((version) => version + 1)} />
      </Suspense>
    </div>
  );
}
