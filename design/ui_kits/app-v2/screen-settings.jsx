/* Settings — a grouped, searchable hub (E1) with unmistakable resets (E2).
   Search jumps to any control; everyday groups first, Advanced (Beta) and the
   danger zone last; long operations show inline progress, never a blocked
   screen (E3); the factory reset enumerates exactly what it destroys. */

function SettingsScreen({ theme, onTheme, onImport, onReplayTour, onSnack }) {
  const { useState } = React;
  const [q, setQ] = useState('');
  const [drill, setDrill] = useState(null);   // 'study' | 'algorithm'
  const [eraseOpen, setEraseOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const match = (...words) => !q || words.some(w => w.toLowerCase().includes(q.toLowerCase()));

  const doExport = () => {
    setExporting(true);
    setTimeout(() => { setExporting(false); onSnack('Backup exported — maranki-backup.json'); }, 1400);
  };

  if (drill === 'study') return <StudyPrefs onBack={() => setDrill(null)} />;
  if (drill === 'algorithm') return <AlgorithmPrefs onBack={() => setDrill(null)} />;

  return <Page>
    <ScreenHead title="Settings" />

    <div style={{
      display: 'flex', alignItems: 'center', gap: 9, background: T.card, border: `1px solid ${T.hairStrong}`,
      borderRadius: 999, padding: '10px 16px', margin: '12px 0 4px',
    }}>
      <Ion name="search" size={16} color={T.ink3} />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search settings…"
        style={{ flex: 1, border: 'none', background: 'none', fontFamily: T.sans, fontSize: 14, color: T.ink }} />
      {q && <Ion name="close-circle" size={16} color={T.ink3} style={{ cursor: 'pointer' }} onClick={() => setQ('')} />}
    </div>

    {match('theme', 'appearance', 'dark', 'evening', 'light') && <div>
      <SectionHead>Appearance</SectionHead>
      <SegCtrl value={theme} onChange={onTheme} options={[
        { id: 'light', label: 'Paper', icon: 'sunny-outline' },
        { id: 'dark', label: 'Evening', icon: 'moon-outline' },
        { id: 'system', label: 'System', icon: 'phone-portrait-outline' },
      ]} />
    </div>}

    {(match('learning', 'study', 'goals', 'daily', 'mode', 'hints') || match('language')) && <div>
      <SectionHead>Learning</SectionHead>
      {match('learning', 'study', 'goals', 'daily', 'mode', 'hints') &&
        <ListRow icon="school-outline" title="Study & goals" sub="30 reviews · 10 new per day · flashcards · hints on" onClick={() => setDrill('study')} />}
      {match('language') &&
        <ListRow icon="globe-outline" title="Languages" sub="Interface English · learning German" onClick={() => onSnack('Language picker')} />}
      {match('reminders', 'notifications') &&
        <ListRow icon="notifications-outline" title="Reminders" sub="Daily at 9:00 PM · next: tomorrow" last
          right={<Toggle on onChange={() => onSnack('Reminders updated')} />} />}
    </div>}

    {match('pronunciation', 'audio', 'speech', 'freeze', 'streak') && <div>
      <SectionHead>Habit & speech</SectionHead>
      {match('pronunciation', 'audio', 'speech') &&
        <ListRow icon="mic-outline" title="Pronunciation practice" sub="Prompt on hard cards"
          right={<Toggle on onChange={() => onSnack('Pronunciation setting updated')} />} />}
      {match('audio', 'speech') &&
        <ListRow icon="volume-high-outline" title="Auto-play audio" sub="Speak the word on reveal"
          right={<Toggle on={false} onChange={() => onSnack('Auto-play updated')} />} />}
      {match('freeze', 'streak') &&
        <ListRow icon="snow-outline" iconColor={T.info} iconBg={T.infoTint} title="Streak freezes" sub="2 available · earn one at every 7-day milestone" last
          right={<Pill mono>2</Pill>} />}
    </div>}

    {match('data', 'import', 'export', 'backup', 'restore') && <div>
      <SectionHead>Your data</SectionHead>
      <ListRow icon="cloud-download-outline" title="Import" sub="CSV · Anki file · AnkiWeb" onClick={onImport} />
      <ListRow icon="cloud-upload-outline" title="Export a backup" sub="Everything — cards, progress, settings"
        onClick={exporting ? undefined : doExport}
        right={exporting
          ? <span style={{ fontFamily: T.sans, fontSize: 12.5, fontWeight: 700, color: T.pine }}>Exporting…</span>
          : <Ion name="chevron-forward" size={16} color={T.ink3} />} />
      <ListRow icon="refresh-circle-outline" title="Restore a backup" sub="From a Maranki JSON file" last onClick={() => onSnack('Choose a backup file to restore')} />
    </div>}

    {match('advanced', 'algorithm', 'sm2', 'ease', 'steps', 'beta') && <div>
      <SectionHead>Advanced</SectionHead>
      <ListRow icon="options-outline" iconColor={T.warning} iconBg={T.warningTint} title="Algorithm tuning"
        sub="Beta — changes how cards are scheduled" onClick={() => setDrill('algorithm')} last />
    </div>}

    {match('help', 'tour', 'about', 'faq') && <div>
      <SectionHead>Help</SectionHead>
      <ListRow icon="help-buoy-outline" title="Help & FAQ" onClick={() => onSnack('Help center')} />
      <ListRow icon="play-circle-outline" title="Replay the tour" sub="Re-run first-time setup" onClick={onReplayTour} last />
    </div>}

    {match('reset', 'erase', 'delete', 'danger') && <div>
      <SectionHead>Danger zone</SectionHead>
      <div style={{ border: `1px solid ${softTint(T.danger, 30)}`, borderRadius: 14, padding: '2px 14px', background: softTint(T.danger, 4) }}>
        <ListRow icon="refresh-outline" danger title="Reset preferences to defaults"
          sub="Keeps every card, deck, streak and session" onClick={() => onSnack('Preferences reset — your study data is untouched')} />
        <ListRow icon="trash-outline" danger title="Erase everything & start over"
          sub="Deletes all content and settings" last onClick={() => setEraseOpen(true)} />
      </div>
    </div>}

    <div style={{ textAlign: 'center', fontFamily: T.mono, fontSize: 11.5, color: T.ink3, padding: '26px 0 4px' }}>
      Maranki 2.0 · made with care</div>

    {/* factory-reset confirm: enumerated consequences (E2) */}
    <Sheet open={eraseOpen} onClose={() => setEraseOpen(false)} title="Erase everything?">
      <div style={{ fontFamily: T.sans, fontSize: 14, color: T.ink2, lineHeight: 1.5, marginBottom: 12 }}>
        This is a factory reset. It permanently deletes:</div>
      <div style={{ background: T.dangerTint, borderRadius: 14, padding: '13px 16px', marginBottom: 16 }}>
        {['5 decks and 1,240 cards', 'All scheduling progress and 286 sessions', `Your ${PERSON.streak}-day streak and level ${PERSON.level}`, 'Every setting, theme and reminder'].map(s => (
          <div key={s} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontFamily: T.sans, fontSize: 13.5, color: T.danger }}>
            <Ion name="close-circle" size={15} />{s}</div>
        ))}
      </div>
      <Btn kind="secondary" full icon="cloud-upload-outline" onClick={() => { setEraseOpen(false); onSnack('Backup exported — maranki-backup.json'); }}
        style={{ marginBottom: 10 }}>Export a backup first</Btn>
      <Btn kind="dangerSolid" full onClick={() => { setEraseOpen(false); onSnack('Nothing was erased — this is a demo'); }}>
        Hold to erase everything</Btn>
      <button onClick={() => setEraseOpen(false)} style={{
        display: 'block', margin: '14px auto 0', background: 'none', border: 'none', cursor: 'pointer',
        fontFamily: T.sans, fontWeight: 700, fontSize: 14, color: T.ink2,
      }}>Keep my data</button>
    </Sheet>
  </Page>;
}

/* drill-in: study & goals */
function StudyPrefs({ onBack }) {
  const { useState } = React;
  const [reviews, setReviews] = useState(30);
  const [neww, setNeww] = useState(10);
  const [limit, setLimit] = useState(50);
  const [mode, setMode] = useState('flash');
  const [hints, setHints] = useState(true);
  const [retry, setRetry] = useState(true);
  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 45 }}>
    <StackBar title="Study & goals" onBack={onBack} />
    <div className="mk-scroll" style={{ position: 'absolute', top: TOPPAD + 48, bottom: 0, left: 0, right: 0, overflowY: 'auto', padding: `8px 20px ${TABH + 20}px` }}>
      <SectionHead>Daily goal</SectionHead>
      <Row pad="12px 0"><span style={{ flex: 1, fontFamily: T.sans, fontSize: 14.5, color: T.ink }}>Reviews per day</span><Stepper value={reviews} onChange={setReviews} min={0} max={500} step={10} /></Row>
      <Row pad="12px 0"><span style={{ flex: 1, fontFamily: T.sans, fontSize: 14.5, color: T.ink }}>New cards per day</span><Stepper value={neww} onChange={setNeww} min={0} max={100} step={5} /></Row>
      <Row pad="12px 0" last><span style={{ flex: 1, fontFamily: T.sans, fontSize: 14.5, color: T.ink }}>Session limit</span><Stepper value={limit} onChange={setLimit} min={5} max={100} step={5} /></Row>
      <SectionHead>Study mode</SectionHead>
      <SegCtrl value={mode} onChange={setMode} options={[
        { id: 'flash', label: 'Cards' }, { id: 'type', label: 'Typing' }, { id: 'mc', label: 'Quiz' }, { id: 'mix', label: 'Mixed' },
      ]} />
      <SectionHead>Behavior</SectionHead>
      <Row pad="12px 0"><span style={{ flex: 1, fontFamily: T.sans, fontSize: 14.5, color: T.ink }}>Hints</span><Toggle on={hints} onChange={setHints} /></Row>
      <Row pad="12px 0" last>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.sans, fontSize: 14.5, color: T.ink }}>Retry missed cards</div>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>An extra round at the end of a session</div>
        </div>
        <Toggle on={retry} onChange={setRetry} /></Row>
    </div>
  </div>;
}

/* drill-in: algorithm tuning — steppers + plain language + per-knob reset (E4) */
function AlgorithmPrefs({ onBack }) {
  const { useState } = React;
  const [easy, setEasy] = useState(1.3);
  const [hard, setHard] = useState(0.85);
  const knob = (label, plain, val, set, min, max, step, dflt, fmt) => (
    <div style={{ padding: '14px 0', borderBottom: `1px solid ${T.hairSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 14.5, color: T.ink }}>{label}</div>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 2 }}>{plain}</div>
        </div>
        <Stepper value={val} onChange={n => set(Math.round(n * 100) / 100)} min={min} max={max} step={step} fmt={fmt} />
      </div>
      {val !== dflt && <button onClick={() => set(dflt)} style={{
        background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.sans, fontSize: 12, fontWeight: 700,
        color: T.pine, padding: '6px 0 0',
      }}>Reset to default ({fmt(dflt)})</button>}
    </div>
  );
  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 45 }}>
    <StackBar title="Algorithm tuning" sub="Beta — changes apply instantly" onBack={onBack} />
    <div className="mk-scroll" style={{ position: 'absolute', top: TOPPAD + 48, bottom: 0, left: 0, right: 0, overflowY: 'auto', padding: `14px 20px ${TABH + 20}px` }}>
      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', background: T.warningTint, borderRadius: 12,
        padding: '11px 14px', fontFamily: T.sans, fontSize: 13, color: T.ink, lineHeight: 1.45,
      }}>
        <Ion name="warning-outline" size={17} color={T.warning} style={{ marginTop: 1 }} />
        These knobs reshape your review schedule. The defaults work well for most learners.
      </div>
      {knob('Easy bonus', `Easy cards wait ${Math.round((easy - 1) * 100)}% longer`, easy, setEasy, 1.0, 3.0, 0.05, 1.3, n => `${n.toFixed(2)}×`)}
      {knob('Hard penalty', `Hard cards grow ${Math.round((1 - hard) * 100)}% slower`, hard, setHard, 0.5, 1.0, 0.05, 0.85, n => `${n.toFixed(2)}×`)}
      <div style={{ padding: '14px 0' }}>
        <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 14.5, color: T.ink, marginBottom: 8 }}>Learning steps</div>
        <SegCtrl value="standard" onChange={() => {}} options={[
          { id: 'relaxed', label: 'Relaxed' }, { id: 'standard', label: 'Standard' }, { id: 'intensive', label: 'Intensive' },
        ]} />
        <div style={{ fontFamily: T.mono, fontSize: 12, color: T.ink3, marginTop: 8 }}>steps: 1m → 10m · graduate at 1d</div>
      </div>
    </div>
  </div>;
}

Object.assign(window, { SettingsScreen, StudyPrefs, AlgorithmPrefs });
