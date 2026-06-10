/* Session complete — the payout, then momentum (A2 + C1).
   The reward is one skippable layer: everything renders at once with a
   staggered rise; "Done for today" is always one tap away. XP is itemized
   and counts up, the level bar fills, achievements pop — then the
   "keep going" hub offers study-ahead / hardest / cram instead of a wall. */

function StatTile({ value, label, accent }) {
  return <div style={{ flex: 1, textAlign: 'center', padding: '14px 4px' }}>
    <div style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em', color: accent || T.ink, fontFeatureSettings: "'tnum' 1" }}>{value}</div>
    <div style={{ fontFamily: T.sans, fontSize: 12, fontWeight: 650, color: T.ink3, marginTop: 2 }}>{label}</div>
  </div>;
}

function CompleteScreen({ result, deckName = 'German — Everyday', onAgain, onDone }) {
  const { useState, useEffect } = React;
  const counts = result?.counts || { again: 1, hard: 1, good: 3, easy: 2 };
  const total = result?.total || 7;
  const correct = total - counts.again;
  const acc = Math.round(correct / total * 100);
  const xpItems = [
    { label: `${total} cards reviewed`, xp: total * 2 },
    { label: `${correct} correct`, xp: correct * 2 },
    { label: 'Daily streak · day 12', xp: 10 },
    { label: `${result?.bestRun || 5} in a row`, xp: 8 },
  ];
  const xpTotal = xpItems.reduce((s, i) => s + i.xp, 0);
  const [xpShown, setXpShown] = useState(0);

  useEffect(() => {
    let n = 0;
    const t = setInterval(() => {
      n += Math.ceil(xpTotal / 24);
      if (n >= xpTotal) { n = xpTotal; clearInterval(t); }
      setXpShown(n);
    }, 40);
    return () => clearInterval(t);
  }, []);

  const tier = acc >= 90 ? ['Brilliant session.', 'Your recall is razor-sharp today.']
    : acc >= 70 ? ['Strong recall today.', 'Your retention is climbing.']
    : ['Good, honest work.', 'The misses will come back soon — that’s the system working.'];

  const seg = (n, color) => total ? <div style={{ width: `${n / total * 100}%`, background: color }} /> : null;

  return <div className="mk-scroll" style={{
    position: 'absolute', inset: 0, background: T.paper, zIndex: 50, overflowY: 'auto',
    padding: `0 22px 30px`, boxSizing: 'border-box',
  }}>
    <div style={{ padding: `${TOPPAD + 18}px 0 0`, textAlign: 'center', animation: 'riseIn .35s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{
        width: 54, height: 54, borderRadius: 999, background: T.pineTint, margin: '0 auto 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Ion name="checkmark" size={28} color={T.pine} /></div>
      <Overline>Session complete · {deckName}</Overline>
      <h1 style={{ margin: '10px 0 6px', fontFamily: T.serif, fontWeight: 600, fontSize: 30, letterSpacing: '-0.02em', color: T.ink }}>{tier[0]}</h1>
      <div style={{ fontFamily: T.sans, fontSize: 14.5, color: T.ink2 }}>{tier[1]}</div>
    </div>

    {/* headline tiles */}
    <Card style={{ marginTop: 22, padding: '4px 8px', display: 'flex', animation: 'riseIn .4s .05s cubic-bezier(0.22,1,0.36,1) backwards' }}>
      <StatTile value={total} label="Cards" />
      <div style={{ width: 1, background: T.hairSoft, margin: '14px 0' }} />
      <StatTile value={`${acc}%`} label="Accuracy" accent={T.pine} />
      <div style={{ width: 1, background: T.hairSoft, margin: '14px 0' }} />
      <StatTile value="4:12" label="Time" />
    </Card>

    {/* rating breakdown (A3) */}
    <div style={{ marginTop: 18, animation: 'riseIn .4s .1s cubic-bezier(0.22,1,0.36,1) backwards' }}>
      <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', gap: 1, background: T.paperSunk }}>
        {seg(counts.again, T.rateAgain)}{seg(counts.hard, T.rateHard)}{seg(counts.good, T.rateGood)}{seg(counts.easy, T.rateEasy)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontFamily: T.sans, fontSize: 12, color: T.ink3 }}>
        {[['Again', counts.again, T.rateAgain], ['Hard', counts.hard, T.rateHard], ['Good', counts.good, T.rateGood], ['Easy', counts.easy, T.rateEasy]].map(([l, n, c]) =>
          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: c, display: 'inline-block' }} />
            {l} <b style={{ color: T.ink2, fontFeatureSettings: "'tnum' 1" }}>{n}</b>
          </span>)}
      </div>
      {counts.again > 0 && <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 14, color: T.ink2, marginTop: 10, textAlign: 'center' }}>
        {counts.again} {counts.again === 1 ? 'lapse' : 'lapses'} — {counts.again === 1 ? 'it' : 'they'}’ll come back soon.</div>}
    </div>

    {/* XP payout (C1) */}
    <Card style={{ marginTop: 18, animation: 'riseIn .4s .15s cubic-bezier(0.22,1,0.36,1) backwards' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <Overline>Experience</Overline>
        <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 20, color: T.amberDeep, fontFeatureSettings: "'tnum' 1", whiteSpace: 'nowrap' }}>+{xpShown} XP</span>
      </div>
      {xpItems.map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: i < xpItems.length - 1 ? `1px solid ${T.hairSoft}` : 'none' }}>
          <span style={{ fontFamily: T.sans, fontSize: 13.5, color: T.ink2 }}>{it.label}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.ink3 }}>+{it.xp}</span>
        </div>
      ))}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 13, color: T.ink }}>Level {PERSON.level} · {PERSON.levelName}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink3 }}>{PERSON.xpNext - Math.min(xpShown, PERSON.xpNext - 10)} XP to level {PERSON.level + 1}</span>
        </div>
        <Bar value={62 + (xpShown / xpTotal) * 18} color={T.amber} h={6} />
      </div>
    </Card>

    {/* achievement unlock */}
    <div style={{
      marginTop: 14, display: 'flex', alignItems: 'center', gap: 13, background: T.amberTint,
      borderRadius: 16, padding: '13px 16px', animation: 'popIn .4s .5s cubic-bezier(0.34,1.56,0.64,1) backwards',
    }}>
      <div style={{ width: 42, height: 42, borderRadius: 12, background: T.amber, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <Ion name="flash" size={21} color="#fff" />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 14.5, color: T.ink }}>Achievement — Quick draw</div>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink2 }}>50 fast answers · +1 streak freeze earned</div>
      </div>
    </div>

    {/* keep going hub (A2) */}
    <SectionHead>Keep going</SectionHead>
    <div>
      <Row onClick={onAgain} pad="13px 0">
        <div style={{ width: 34, height: 34, borderRadius: 10, background: T.pineTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Ion name="play-forward" size={16} color={T.pine} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>Study ahead</div>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>12 cards due tomorrow · an extra pass</div>
        </div>
        <Ion name="chevron-forward" size={16} color={T.ink3} />
      </Row>
      <Row onClick={onAgain} pad="13px 0">
        <div style={{ width: 34, height: 34, borderRadius: 10, background: T.dangerTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Ion name="flame" size={16} color={T.danger} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>Review hardest</div>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>11 lowest-ease cards across decks</div>
        </div>
        <Ion name="chevron-forward" size={16} color={T.ink3} />
      </Row>
      <Row onClick={onAgain} pad="13px 0" last>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: T.infoTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Ion name="shuffle" size={16} color={T.info} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>Cram this deck</div>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>Free practice — never changes your schedule</div>
        </div>
        <Ion name="chevron-forward" size={16} color={T.ink3} />
      </Row>
    </div>

    <div style={{ marginTop: 20 }}>
      <Btn full size="lg" onClick={onDone}>Done for today</Btn>
    </div>
  </div>;
}

Object.assign(window, { CompleteScreen, StatTile });
