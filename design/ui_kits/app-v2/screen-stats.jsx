/* Progress (Stats) — progression that drives action (C1 + C5).
   Level + XP at the top, the streak and mastery heroes, every high-intent
   number a launcher (due → study, weak cards → review), an honest activity
   heatmap, the achievements wall, and a quiet all-time ledger. */

function HeatCell({ v }) {
  const colors = ['transparent', softTint(T.pine, 18), softTint(T.pine, 38), softTint(T.pine, 65), T.pine];
  return <div style={{
    width: '100%', aspectRatio: '1', borderRadius: 5, background: colors[v],
    border: v === 0 ? `1px solid ${T.hairSoft}` : 'none', boxSizing: 'border-box',
  }} />;
}

function StatsScreen({ onStartSession, onSnack }) {
  const { useState } = React;
  const [range, setRange] = useState('5w');

  return <Page>
    <ScreenHead title="Progress" sub="Level, habit, and mastery — all in one place."
      right={<IconBtn icon="download-outline" size={36} iconSize={17} border onClick={() => onSnack('Exported study history (CSV)')} />} />

    {/* level ribbon */}
    <Card style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
      <Ring value={62} size={52} stroke={4.5} color={T.amber}>
        <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 17, color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{PERSON.level}</span>
      </Ring>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 15.5, color: T.ink }}>Level {PERSON.level} · {PERSON.levelName}</div>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, fontFeatureSettings: "'tnum' 1" }}>{PERSON.xpNext} XP to level {PERSON.level + 1}</div>
      </div>
      <Pill mono fg={T.amberDeep} bg={T.amberTint}>{PERSON.xp.toLocaleString('en-US')} XP</Pill>
    </Card>

    {/* heroes: streak + mastery */}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
      <Card pad={16}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Ion name="flame" size={16} color={T.amber} />
          <Overline>Streak</Overline>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, margin: '8px 0 2px' }}>
          <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 34, letterSpacing: '-0.03em', color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{PERSON.streak}</span>
          <span style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3 }}>days</span>
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 12, color: T.ink3 }}>best {PERSON.best} · <Ion name="snow" size={10} color={T.info} /> {PERSON.freezes} freezes</div>
        <div style={{ display: 'flex', gap: 3, marginTop: 11 }}>
          {DAYS14.slice(-7).map((d, i) => <div key={i} style={{
            flex: 1, height: 5, borderRadius: 99,
            background: d === 's' || d === 't' ? T.amber : d === 'f' ? T.info : T.paperSunk,
          }} />)}
        </div>
      </Card>
      <Card pad={16}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Ion name="checkmark-circle" size={16} color={T.pine} />
          <Overline>Mastered</Overline>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <Ring value={PERSON.masteryPct} size={56} stroke={5}>
            <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 14.5, color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{PERSON.masteryPct}%</span>
          </Ring>
          <div style={{ fontFamily: T.sans, fontSize: 12, color: T.ink3, lineHeight: 1.5, fontFeatureSettings: "'tnum' 1" }}>
            {PERSON.masteredCards}<br />of {PERSON.totalCards.toLocaleString('en-US')}</div>
        </div>
      </Card>
    </div>

    {/* actionable metrics (C5) */}
    <SectionHead>Today</SectionHead>
    <Row onClick={onStartSession} pad="13px 0">
      <div style={{ width: 34, height: 34, borderRadius: 10, background: T.pineTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <Ion name="time-outline" size={17} color={T.pine} /></div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>{READY.due} cards due</div>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>{PERSON.studiedToday} studied so far today</div>
      </div>
      <Btn size="sm">Start</Btn>
    </Row>
    <Row onClick={() => onSnack('Queued 11 weak cards for review')} pad="13px 0" last>
      <div style={{ width: 34, height: 34, borderRadius: 10, background: T.warningTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <Ion name="trending-down" size={17} color={T.warning} /></div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>Retention dipped to {PERSON.retention}%</div>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>11 weak cards could use a review</div>
      </div>
      <Btn size="sm" kind="secondary">Review</Btn>
    </Row>

    {/* activity */}
    <SectionHead action={<SegCtrl size="sm" options={[{ id: '5w', label: '5 weeks' }, { id: 'y', label: 'Year' }]} value={range} onChange={setRange} />}>
      Activity</SectionHead>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 5, padding: '10px 0 6px' }}>
      {HEAT.flat().map((v, i) => <HeatCell key={i} v={range === 'y' ? Math.max(0, v - 1) : v} />)}
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.sans, fontSize: 11.5, color: T.ink3 }}>
      <span>{range === '5w' ? 'May 5' : 'Jun 2025'}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>less
        {[0, 1, 2, 3, 4].map(v => <span key={v} style={{ width: 9, height: 9, borderRadius: 3, background: v === 0 ? T.paperSunk : softTint(T.pine, [0, 18, 38, 65, 100][v]) }} />)}
        more</span>
      <span>today</span>
    </div>

    {/* by level */}
    <SectionHead>By level</SectionHead>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11, padding: '8px 0 2px' }}>
      {[['A1', 92], ['A2', 81], ['B1', 56], ['B2', 23]].map(([l, p]) => (
        <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <LevelBadge level={l} />
          <div style={{ flex: 1 }}><Bar value={p} color={CEFR[l][0]} /></div>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink3, width: 34, textAlign: 'right' }}>{p}%</span>
        </div>
      ))}
    </div>

    {/* achievements wall */}
    <SectionHead action={<span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink3 }}>4/8</span>}>Achievements</SectionHead>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '10px 0 4px' }}>
      {ACHIEVEMENTS.map(a => (
        <div key={a.id} style={{ textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: 16, margin: '0 auto 7px',
            background: a.unlocked ? T.amber : T.paperSunk,
            border: a.unlocked ? 'none' : `1px dashed ${T.hairStrong}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: a.unlocked ? T.shSm : 'none',
          }}><Ion name={a.unlocked ? a.icon : 'lock-closed'} size={21} color={a.unlocked ? '#fff' : T.ink3} /></div>
          <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 11, color: a.unlocked ? T.ink : T.ink3, lineHeight: 1.25 }}>{a.name}</div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink3, marginTop: 1 }}>
            {a.unlocked ? a.date : `${a.prog}/${a.goal}`}</div>
        </div>
      ))}
    </div>

    {/* all-time ledger */}
    <SectionHead>All time</SectionHead>
    <div>
      {[['Total reviews', '12,418'], ['Sessions', '286'], ['Average per session', '23 cards'], ['Days active', '164']].map(([l, n], i, arr) => (
        <Row key={l} pad="11px 0" last={i === arr.length - 1}>
          <span style={{ flex: 1, fontFamily: T.sans, fontSize: 14, color: T.ink2 }}>{l}</span>
          <span style={{ fontFamily: T.mono, fontSize: 13.5, color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{n}</span>
        </Row>
      ))}
    </div>
  </Page>;
}

Object.assign(window, { StatsScreen, HeatCell });
