import { Fragment, Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import BrandMark from './BrandMark.jsx';
import Button from './Button.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import OnboardingNotice from './OnboardingNotice.jsx';
import TeamInvitationNotice from './TeamInvitationNotice.jsx';
import UserAvatar from './UserAvatar.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useChatUnread } from '../hooks/useChatUnread.js';
import { displayNameFor } from '../services/profileUtils.js';
import { DRAWER_MAX_WIDTH, RAIL_MAX_WIDTH, markPageSeen, readCollapsed, readSeenPages, tooltipPosition, writeCollapsed } from '../services/sidebarState.js';
import { ADMIN_PATHS, NEW_PAGE_IDS, PAGES, homePathFor, navigationFor, pageForPath, roleOf } from '../routes.js';

const JackFloatingWidget = lazy(() => import('./JackFloatingWidget.jsx'));

const storage = () => (typeof window === 'undefined' ? null : window.localStorage);
const RAIL_QUERY = `(min-width: ${DRAWER_MAX_WIDTH + 1}px) and (max-width: ${RAIL_MAX_WIDTH}px)`;

// True on a tablet-sized window, where the menu stays on screen as the icon bar instead of hiding behind a button.
function useRailMode() {
  const [rail, setRail] = useState(() => typeof window !== 'undefined' && window.matchMedia(RAIL_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(RAIL_QUERY);
    const update = () => setRail(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return rail;
}

export default function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storage()));
  const [seen, setSeen] = useState(() => readSeenPages(storage()));
  const [tooltip, setTooltip] = useState(null);
  const rail = useRailMode();
  const [dataVersion, setDataVersion] = useState(0);
  const { t } = useLocale();
  const { user, profile, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const role = roleOf(profile);
  const sections = navigationFor(role);
  const page = pageForPath(location.pathname);
  const unreadChat = useChatUnread(user?.id, role === 'coach' || role === 'client');
  const chatPageId = role === 'client' ? 'coachHub' : 'messages';

  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  // A page with a "New" badge stops showing it once it has been opened.
  useEffect(() => {
    const opened = NEW_PAGE_IDS.find((id) => PAGES[id].path === location.pathname);
    if (opened) setSeen(markPageSeen(storage(), opened));
  }, [location.pathname]);

  // Escape closes the drawer on a phone.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const toggleCollapsed = useCallback(() => {
    setTooltip(null);
    setCollapsed((current) => {
      writeCollapsed(storage(), !current);
      return !current;
    });
  }, []);

  // The narrow icon bar has no room for labels, so the name of the item under the pointer or focus floats beside it.
  const showTooltip = useCallback((event, label) => {
    if (!(collapsed || rail) || window.innerWidth <= DRAWER_MAX_WIDTH) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, ...tooltipPosition(rect, { rtl: document.documentElement.dir === 'rtl', viewportWidth: window.innerWidth }) });
  }, [collapsed, rail]);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  const toggleLabel = t(collapsed ? 'sidebarExpand' : 'sidebarCollapse');

  return (
    <div className={`app-shell ${collapsed ? 'is-collapsed' : ''} ${rail ? 'is-rail' : ''}`}>
      <div className={`sidebar-backdrop ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`} aria-label={t('main')}>
        <div className="sidebar-head">
          <button className="sidebar-brand" onClick={() => navigate(homePathFor(role))} aria-label={`ApexFit ${t('home')}`}><BrandMark /></button>
          <button className="sidebar-toggle" type="button" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-label={toggleLabel} title={toggleLabel}
            onMouseEnter={(event) => showTooltip(event, toggleLabel)} onMouseLeave={hideTooltip} onFocus={(event) => showTooltip(event, toggleLabel)} onBlur={hideTooltip}>
            <span aria-hidden="true" className="sidebar-toggle-icon">‹</span>
          </button>
          <button className="sidebar-close" type="button" onClick={() => setMenuOpen(false)} aria-label={t('closeNavigation')}>✕</button>
        </div>
        <nav className="side-nav" aria-label={t('main')} onScroll={hideTooltip}>
          {sections.map((section) => (
            <div className="nav-section" key={section.group}>
              <span className="nav-heading">{t(section.group)}</span>
              {section.items.map((id) => {
                const label = t(PAGES[id].titleKey);
                const unread = id === chatPageId && unreadChat > 0;
                const isNew = NEW_PAGE_IDS.includes(id) && !seen.includes(id);
                return (
                  <NavLink
                    key={id}
                    to={PAGES[id].path}
                    className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}
                    aria-label={collapsed || rail ? label : undefined}
                    onMouseEnter={(event) => showTooltip(event, label)}
                    onMouseLeave={hideTooltip}
                    onFocus={(event) => showTooltip(event, label)}
                    onBlur={hideTooltip}
                  >
                    <span className="nav-icon" aria-hidden="true">{PAGES[id].icon}</span>
                    <span className="nav-label">{label}</span>
                    {unread && <span className="nav-badge" aria-label={`${unreadChat} ${t('chatUnread')}`}>{unreadChat > 99 ? '99+' : unreadChat}</span>}
                    {isNew && !unread && <span className="nav-badge nav-badge-new">{t('sidebarNew')}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <NavLink className="sidebar-profile" to={PAGES.settings.path} aria-label={t('settings')}
          onMouseEnter={(event) => showTooltip(event, displayNameFor(profile, user) || t('settings'))} onMouseLeave={hideTooltip}>
          <UserAvatar user={user} profile={profile} />
          <div className="profile-copy">
            <strong>{displayNameFor(profile, user) || t('signedOut')}</strong>
            <span>{profile ? t(profile.role) : t('account')}</span>
          </div>
        </NavLink>
      </aside>
      {tooltip && <div className="nav-tooltip" role="tooltip" style={{ top: tooltip.top, left: tooltip.left, right: tooltip.right }}>{tooltip.label}</div>}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title-wrap">
            <button className="menu-toggle" onClick={() => setMenuOpen(true)} aria-label={t('openNavigation')} aria-expanded={menuOpen}>☰</button>
            <h1 className="topbar-title">{t(page?.titleKey || (location.pathname === ADMIN_PATHS.ai ? 'adminAiTitle' : 'dashboard'))}</h1>
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
