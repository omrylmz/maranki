/* Maranki App Redesign v2 — orchestrator.
   Owns: tab state, overlays (session / complete / editors / import /
   onboarding), the universal peek + create sheets, the global snackbar,
   theming (paper ⇆ evening via data-theme), and the Tweaks panel. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "heroStyle": "stack",
  "paperGrain": true
}/*EDITMODE-END*/;

function MarankiApp({ t, setTweak }) {
  const { useState, useEffect } = React;
  const [tab, setTab] = useState('home');
  const [overlay, setOverlay] = useState(null);   // {kind: 'session'|'complete'|'cardEditor'|'deckEditor'|'import'|'onboarding', ...}
  const [peek, setPeek] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [streakOpen, setStreakOpen] = useState(false);
  const [snack, setSnack] = useState(null);
  const [themeOverride, setThemeOverride] = useState(null); // moon toggle on Home

  const theme = themeOverride || (t.theme === 'system' ? 'light' : t.theme);

  useEffect(() => {
    if (!snack) return;
    const tm = setTimeout(() => setSnack(null), 2800);
    return () => clearTimeout(tm);
  }, [snack]);

  const startSession = () => setOverlay({ kind: 'session' });
  const showSnack = text => setSnack(text);

  const closePeekAnd = fn => { const o = peek; setPeek(null); fn(o); };

  return (
    <div data-theme={theme === 'dark' ? 'dark' : undefined}
      style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--paper)', overflow: 'hidden' }}>
      {t.paperGrain && <div className="paper-grain-overlay" style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, opacity: 'var(--grain-opacity)',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
      }} />}

      {/* ——— tabs ——— */}
      {tab === 'home' && <HomeScreen
        heroStyle={t.heroStyle}
        theme={theme}
        onToggleTheme={() => setThemeOverride(theme === 'dark' ? 'light' : 'dark')}
        onStartSession={startSession}
        onPeekDeck={setPeek}
        onStudyDeck={startSession}
        onManage={() => setTab('study')}
        onOpenStreak={() => setStreakOpen(true)} />}
      {tab === 'study' && <LaunchpadScreen
        onStartSession={startSession}
        onPeek={setPeek}
        onStudy={startSession}
        onCreate={() => setCreateOpen(true)}
        onImport={() => setOverlay({ kind: 'import' })}
        onSnack={showSnack} />}
      {tab === 'browse' && <BrowseScreen
        onEditCard={card => setOverlay({ kind: 'cardEditor', card })}
        onCreate={() => setCreateOpen(true)}
        onSnack={showSnack} />}
      {tab === 'stats' && <StatsScreen onStartSession={startSession} onSnack={showSnack} />}
      {tab === 'settings' && <SettingsScreen
        theme={t.theme === 'system' && !themeOverride ? 'system' : theme}
        onTheme={v => { setThemeOverride(null); setTweak('theme', v); }}
        onImport={() => setOverlay({ kind: 'import' })}
        onReplayTour={() => setOverlay({ kind: 'onboarding' })}
        onSnack={showSnack} />}

      <TabBar active={tab} onChange={setTab} studyDue={READY.total} />

      {/* ——— overlays ——— */}
      {overlay?.kind === 'session' && <SessionScreen
        onComplete={result => setOverlay({ kind: 'complete', result })}
        onExit={() => setOverlay(null)} />}
      {overlay?.kind === 'complete' && <CompleteScreen
        result={overlay.result}
        onAgain={startSession}
        onDone={() => { setOverlay(null); setTab('home'); }} />}
      {overlay?.kind === 'cardEditor' && <CardEditor
        card={overlay.card} deckId={overlay.deckId}
        onBack={() => setOverlay(null)} onSnack={showSnack} />}
      {overlay?.kind === 'deckEditor' && <DeckEditor
        deck={overlay.deck}
        onBack={() => setOverlay(null)} onSnack={showSnack} />}
      {overlay?.kind === 'import' && <ImportScreen
        onBack={() => setOverlay(null)} onSnack={showSnack}
        onStudy={startSession} />}
      {overlay?.kind === 'onboarding' && <OnboardingScreen
        onDone={() => setOverlay(null)}
        onStartSession={startSession}
        onImport={() => setOverlay({ kind: 'import' })} />}

      {/* ——— universal sheets ——— */}
      <PeekSheet obj={peek}
        onClose={() => setPeek(null)}
        onStudy={() => closePeekAnd(() => startSession())}
        onBrowse={() => closePeekAnd(() => setTab('browse'))}
        onEdit={() => closePeekAnd(o => o.isCollection
          ? showSnack('Collection editor — filters, sort & status')
          : setOverlay({ kind: 'deckEditor', deck: o }))} />
      <CreateSheet open={createOpen} onClose={() => setCreateOpen(false)}
        onNewCard={() => { setCreateOpen(false); setOverlay({ kind: 'cardEditor' }); }}
        onNewDeck={() => { setCreateOpen(false); setOverlay({ kind: 'deckEditor' }); }}
        onNewCollection={() => { setCreateOpen(false); showSnack('Collection editor — saved smart filters'); }}
        onImport={() => { setCreateOpen(false); setOverlay({ kind: 'import' }); }} />
      <StreakSheet open={streakOpen} onClose={() => setStreakOpen(false)} />

      {snack && <Snackbar text={snack} />}
    </div>
  );
}

function Root() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '28px 16px', boxSizing: 'border-box',
    }}>
      <IOSDevice>
        <MarankiApp t={t} setTweak={setTweak} />
      </IOSDevice>
      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme}
          options={[{ value: 'light', label: 'Paper' }, { value: 'dark', label: 'Evening' }]}
          onChange={v => setTweak('theme', v)} />
        <TweakToggle label="Paper grain" value={t.paperGrain} onChange={v => setTweak('paperGrain', v)} />
        <TweakSection label="Home" />
        <TweakRadio label="Hero" value={t.heroStyle}
          options={[{ value: 'stack', label: 'Card stack' }, { value: 'command', label: 'Command' }]}
          onChange={v => setTweak('heroStyle', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Root />);
