/* Home — the daily ritual page.
   One stateful "Today" command (D1): the actual first card of today's queue
   sits on the page as a physical invitation — tap the stack or the command
   to go straight into the session (not the hub). Honest breakdown, daily-goal
   ledger, streak chip with visible freezes, launchable deck rows (D4). */

function HomeScreen({ onStartSession, onPeekDeck, onStudyDeck, onManage, theme, onToggleTheme, onOpenStreak, heroStyle = 'stack' }) {
  const first = QUEUE[0];

  return <Page>
    {/* ——— header ——— */}
    <div style={{ padding: `${TOPPAD + 8}px 0 0` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Overline>Tuesday · June 9</Overline>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <IconBtn icon={theme === 'dark' ? 'sunny-outline' : 'moon-outline'} onClick={onToggleTheme} size={34} iconSize={17} border />
          <StreakChip days={PERSON.streak} freezes={PERSON.freezes} onClick={onOpenStreak} />
        </div>
      </div>
      <h1 style={{ margin: '10px 0 0', fontFamily: T.serif, fontWeight: 600, fontSize: 34, lineHeight: 1.05, letterSpacing: '-0.02em', color: T.ink }}>
        Good evening.</h1>
      <div style={{ fontFamily: T.sans, fontSize: 15, color: T.ink2, marginTop: 7 }}>
        {READY.total} cards ready · about {READY.mins} min</div>
    </div>

    {/* ——— the invitation ——— */}
    {heroStyle === 'stack' ? (
      <div style={{ margin: '24px 0 0' }}>
        <div onClick={onStartSession} style={{ position: 'relative', cursor: 'pointer', padding: '10px 0 0' }}>
          {/* stack edges */}
          <div style={{ position: 'absolute', left: 18, right: 18, top: 0, height: 40, background: T.card, border: `1px solid ${T.hair}`, borderRadius: 16, transform: 'rotate(-1.2deg)', opacity: 0.6 }} />
          <div style={{ position: 'absolute', left: 9, right: 9, top: 5, height: 40, background: T.card, border: `1px solid ${T.hair}`, borderRadius: 16, transform: 'rotate(0.7deg)', opacity: 0.85 }} />
          {/* top card = first word of the queue */}
          <div style={{
            position: 'relative', background: T.card, border: `1px solid ${T.hair}`, borderRadius: 18,
            boxShadow: T.shCard, padding: '20px 22px 18px', textAlign: 'center',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Overline style={{ letterSpacing: '0.11em' }}>Up first</Overline>
              <LevelBadge level={first.level} />
            </div>
            <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 36, letterSpacing: '-0.015em', color: T.ink, margin: '18px 0 4px', lineHeight: 1.05 }}>
              {first.word}</div>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.ink3, marginBottom: 18, whiteSpace: 'nowrap' }}>{first.ipa}</div>
            <div style={{
              display: 'flex', justifyContent: 'center', gap: 18, paddingTop: 14,
              borderTop: `1px solid ${T.hairSoft}`, fontFamily: T.sans, fontSize: 13, color: T.ink2,
            }}>
              <span style={{ whiteSpace: 'nowrap' }}><b style={{ color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{READY.due}</b> due</span>
              <span style={{ whiteSpace: 'nowrap' }}><b style={{ color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{READY.neww}</b> new</span>
              <span style={{ whiteSpace: 'nowrap' }}><b style={{ color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{READY.learning}</b> learning</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <Btn full size="lg" icon="play" onClick={onStartSession} style={{ animation: 'pulseSoft 3.2s ease-in-out infinite' }}>
            Start review</Btn>
        </div>
      </div>
    ) : (
      /* command-panel variant */
      <div style={{
        margin: '24px 0 0', background: T.pine, borderRadius: 18, padding: '20px 22px 18px',
        boxShadow: T.shMd, color: T.inkOn,
      }}>
        <Overline style={{ color: 'rgba(255,255,255,0.7)' }}>Today</Overline>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '8px 0 2px' }}>
          <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 46, letterSpacing: '-0.03em', fontFeatureSettings: "'tnum' 1" }}>{READY.total}</span>
          <span style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 21 }}>cards ready</span>
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 13.5, opacity: 0.85, marginBottom: 16 }}>
          {READY.due} due · {READY.neww} new · {READY.learning} learning</div>
        <Btn kind="reward" full size="lg" icon="play" onClick={onStartSession}>Start review · ~{READY.mins} min</Btn>
      </div>
    )}

    {/* ——— today's ledger: goal + habit status ——— */}
    <SectionHead>Daily goal</SectionHead>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, padding: '10px 0 4px' }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 650, color: T.ink2 }}>Reviews</span>
          <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.ink3 }}>{PERSON.doneReviews}/{PERSON.goalReviews}</span>
        </div>
        <Bar value={PERSON.doneReviews / PERSON.goalReviews * 100} color={T.pine} />
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
          <span style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 650, color: T.ink2 }}>New cards</span>
          <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.ink3 }}>{PERSON.doneNew}/{PERSON.goalNew}</span>
        </div>
        <Bar value={PERSON.doneNew / PERSON.goalNew * 100} color={T.amber} />
      </div>
    </div>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 0',
      fontFamily: T.sans, fontSize: 13, color: T.ink2,
    }}>
      <Ion name="shield-checkmark" size={15} color={T.success} />
      <span>Streak safe today · next reminder <b>9:00 PM</b></span>
    </div>

    {/* ——— decks ledger ——— */}
    <SectionHead actionLabel="Manage" onAction={onManage}>Your decks</SectionHead>
    <div>
      {DECKS.filter(d => d.active).map((d, i, arr) => (
        <Row key={d.id} onClick={() => onPeekDeck(d)} last={i === arr.length - 1} pad="15px 0">
          <FlagSq flag={d.flag} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontFamily: T.sans, fontWeight: 700, fontSize: 15.5, color: T.ink,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{d.name}</span>
            </div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, margin: '2px 0 8px', fontFeatureSettings: "'tnum' 1" }}>
              {d.total.toLocaleString('en-US')} cards · {Math.round(d.mastered / d.total * 100)}% mastered</div>
            <SegBar mastered={d.mastered} learning={d.learning} neww={d.neww} total={d.total} />
          </div>
          {d.due > 0 ? (
            <button onClick={e => { e.stopPropagation(); onStudyDeck(d); }} style={{
              flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              background: T.pineTint, border: 'none', borderRadius: 12, padding: '8px 13px', cursor: 'pointer',
            }}>
              <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 16, color: T.pine, fontFeatureSettings: "'tnum' 1" }}>{d.due}</span>
              <span style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 10, color: T.pine, textTransform: 'uppercase', letterSpacing: '0.05em' }}>due</span>
            </button>
          ) : (
            <Ion name="checkmark-circle" size={20} color={T.success} style={{ opacity: 0.7 }} />
          )}
        </Row>
      ))}
    </div>
    <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, padding: '12px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
      <Ion name="information-circle-outline" size={14} />
      2 decks paused — find them under Study.
    </div>
  </Page>;
}

/* streak sheet — visible, explained, earnable freezes (C2) */
function StreakSheet({ open, onClose }) {
  const dot = (d, i) => {
    const map = {
      s: { bg: T.amber, icon: null },
      f: { bg: T.infoTint, icon: 'snow' },
      m: { bg: T.paperSunk, icon: null },
      t: { bg: T.pine, icon: null },
    }[d];
    return <div key={i} style={{
      width: 22, height: 22, borderRadius: 999, background: map.bg, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      border: d === 't' ? `2px solid ${T.pineDeep}` : 'none', boxSizing: 'border-box',
    }}>{map.icon && <Ion name={map.icon} size={12} color={T.info} />}</div>;
  };
  return <Sheet open={open} onClose={onClose} title="Your streak">
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 44, color: T.ink, letterSpacing: '-0.03em', fontFeatureSettings: "'tnum' 1" }}>{PERSON.streak}</span>
      <span style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 19, color: T.ink2 }}>days in a row</span>
    </div>
    <div style={{ fontFamily: T.sans, fontSize: 13.5, color: T.ink3, margin: '2px 0 16px' }}>Best: {PERSON.best} days</div>
    <div style={{ display: 'flex', gap: 7, marginBottom: 8 }}>{DAYS14.map(dot)}</div>
    <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginBottom: 18 }}>Last 14 days · blue = saved by a freeze</div>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, background: T.infoTint, borderRadius: 14, padding: '13px 15px',
    }}>
      <Ion name="snow" size={20} color={T.info} />
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14, color: T.ink }}>{PERSON.freezes} streak freezes</div>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink2 }}>A freeze bridges one missed day. Earn one at every 7-day milestone.</div>
      </div>
    </div>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '11px 15px',
      background: T.successTint, borderRadius: 14, fontFamily: T.sans, fontSize: 13, color: T.ink,
    }}>
      <Ion name="shield-checkmark" size={18} color={T.success} />
      <span>Last week your 12-day streak was saved — 1 freeze used.</span>
    </div>
  </Sheet>;
}

Object.assign(window, { HomeScreen, StreakSheet });
