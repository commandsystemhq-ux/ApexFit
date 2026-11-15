import { useState } from 'react';
import BrandMark from './BrandMark.jsx';
import Button from './Button.jsx';
import LanguageToggle from './LanguageToggle.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

const navigation = [
  { group: 'main', items: [{ id: 'dashboard', icon: '⚡' }, { id: 'generator', icon: '✦' }, { id: 'workoutBuilder', icon: '↕' }, { id: 'programTemplates', icon: '❖' }, { id: 'exerciseLibrary', icon: '⌕' }, { id: 'messages', icon: '◌' }] },
  { group: 'clients', items: [{ id: 'clients', icon: '☺' }, { id: 'schedule', icon: '◷' }, { id: 'invoicing', icon: '$' }, { id: 'community', icon: '★' }, { id: 'portal', icon: '▣' }, { id: 'billing', icon: '◈' }] },
  { group: 'account', items: [{ id: 'settings', icon: '⚙' }] },
];

export default function AppShell({ page, title, onNavigate, onSignIn, onSignOut, user, profile, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { t } = useLocale();
  const sections = profile?.role === 'client'
    ? [
      { group: 'clients', items: [{ id: 'portal', icon: '▣' }, { id: 'coachHub', icon: '✉' }, { id: 'community', icon: '★' }] },
      { group: 'account', items: [{ id: 'settings', icon: '⚙' }] },
    ]
    : navigation;

  function go(id) {
    setMenuOpen(false);
    onNavigate(id);
  }

  return (
    <div className="app-shell">
      <div className={`sidebar-backdrop ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <button className="sidebar-brand" onClick={() => go('home')} aria-label={`ApexFit ${t('home')}`}><BrandMark /></button>
        <nav className="side-nav" aria-label={t('main')}>
          {sections.map((section) => (
            <div className="nav-section" key={section.group}>
              <span className="nav-heading">{t(section.group)}</span>
              {section.items.map(({ id, icon, badge, count }) => (
                <button key={id} className={`nav-link ${page === id ? 'is-active' : ''}`} onClick={() => go(id)}>
                  <span className="nav-icon" aria-hidden="true">{icon}</span>
                  <span>{t(id)}</span>
                  {badge && <span className="nav-badge">{badge}</span>}
                  {count && <span className="nav-count">{count}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-profile">
          <div className="avatar avatar-blue">{user?.email?.slice(0, 1).toUpperCase() || '?'}</div>
          <div className="profile-copy"><strong>{user?.email || t('signedOut')}</strong><span>{profile ? t(profile.role) : t('account')}</span></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title-wrap">
            <button className="menu-toggle" onClick={() => setMenuOpen(true)} aria-label={t('openNavigation')}>☰</button>
            <h1 className="topbar-title">{title}</h1>
          </div>
          <div className="topbar-actions">
            <LanguageToggle />
            {user
              ? <Button variant="secondary" size="small" onClick={onSignOut}>{t('signOut')}</Button>
              : <Button variant="secondary" size="small" onClick={() => onSignIn('coach')}>{t('coachSignIn')}</Button>}
            {profile?.role === 'coach' && <Button variant="primary" size="small" onClick={() => go('generator')}>{t('createPlan')}</Button>}
          </div>
        </header>
        <div className={`page-content page-${page}`}>{children}</div>
      </main>
    </div>
  );
}
