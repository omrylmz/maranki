/* Onboarding — language first (F1). Four data-driven steps, a persistent
   skip, and an exit that lands the learner in a state matching their choice. */

function OnboardingScreen({ onDone, onStartSession, onImport }) {
  const { useState } = React;
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState(null);
  const [neww, setNeww] = useState(10);
  const [reviews, setReviews] = useState(30);

  const mins = Math.max(2, Math.round((neww + reviews) * 10 / 60));
  const next = () => step < 3 ? setStep(step + 1) : onDone();

  const steps = [
    /* 0 — welcome */
    <div key="w" style={{ textAlign: 'center', animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 44, letterSpacing: '-0.02em', color: T.ink, marginTop: 30 }}>Maranki</div>
      <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 19, color: T.ink2, margin: '10px 0 30px' }}>Learn words. Keep them.</div>
      <Card style={{ textAlign: 'left' }}>
        {[
          ['albums-outline', 'Study a few cards a day', 'Short sessions, real sentences.'],
          ['repeat', 'We bring each word back', 'Just before you’d forget it — that’s spaced repetition.'],
          ['flame', 'Streaks make it stick', 'A little every day beats a lot once a week.'],
        ].map(([ic, t, s], i, arr) => (
          <div key={t} style={{ display: 'flex', gap: 13, alignItems: 'flex-start', padding: '11px 0', borderBottom: i < arr.length - 1 ? `1px solid ${T.hairSoft}` : 'none' }}>
            <div style={{ width: 36, height: 36, borderRadius: 11, background: T.pineTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Ion name={ic} size={17} color={T.pine} /></div>
            <div>
              <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>{t}</div>
              <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3, marginTop: 1 }}>{s}</div>
            </div>
          </div>
        ))}
      </Card>
    </div>,

    /* 1 — language first */
    <div key="l" style={{ animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)' }}>
      <h2 style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 26, color: T.ink, margin: '24px 0 6px', lineHeight: 1.15 }}>What do you want to learn?</h2>
      <div style={{ fontFamily: T.sans, fontSize: 14, color: T.ink2, marginBottom: 20 }}>We’ll set up the right decks for you.</div>
      {[['🇩🇪', 'German', '560 cards · A1–B1'], ['🇪🇸', 'Spanish', '180 cards · B1'], ['🇫🇷', 'French', '150 cards · A1']].map(([f, l, s]) => (
        <button key={l} onClick={() => setLang(l)} style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: '13px 15px', marginBottom: 10,
          background: lang === l ? T.pineTint : T.card, borderRadius: 14, cursor: 'pointer', boxSizing: 'border-box',
          border: lang === l ? `1.5px solid ${T.pine}` : `1px solid ${T.hair}`,
        }}>
          <FlagSq flag={f} size={40} />
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 16, color: T.ink }}>{l}</div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>{s}</div>
          </div>
          {lang === l && <Ion name="checkmark-circle" size={22} color={T.pine} />}
        </button>
      ))}
      <button onClick={onImport} style={{
        width: '100%', background: 'none', border: `1.5px dashed ${T.hairStrong}`, borderRadius: 14,
        padding: '13px 15px', cursor: 'pointer', fontFamily: T.sans, fontWeight: 650, fontSize: 14, color: T.ink2,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}><Ion name="cloud-download-outline" size={17} />Or import your own deck</button>
    </div>,

    /* 2 — goals */
    <div key="g" style={{ animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)' }}>
      <h2 style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 28, color: T.ink, margin: '24px 0 4px' }}>A pace you can keep</h2>
      <div style={{ fontFamily: T.sans, fontSize: 14, color: T.ink2, marginBottom: 18 }}>You can change this anytime in Settings.</div>
      <Card>
        <Row pad="12px 0">
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>New words a day</div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>Fresh vocabulary entering rotation</div>
          </div>
          <Stepper value={neww} onChange={setNeww} min={5} max={50} step={5} />
        </Row>
        <Row pad="12px 0" last>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>Reviews a day</div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>Words coming back to be kept</div>
          </div>
          <Stepper value={reviews} onChange={setReviews} min={10} max={200} step={10} />
        </Row>
      </Card>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16,
        fontFamily: T.sans, fontSize: 13.5, color: T.ink2,
      }}>
        <Ion name="time-outline" size={15} color={T.pine} />
        That’s about <b style={{ color: T.ink }}>{mins} minutes</b> a day.
      </div>
    </div>,

    /* 3 — ready */
    <div key="r" style={{ textAlign: 'center', animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{ width: 64, height: 64, borderRadius: 999, background: T.amberTint, margin: '36px auto 18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Ion name="flame" size={30} color={T.amber} /></div>
      <h2 style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 28, color: T.ink, margin: '0 0 8px' }}>
        {lang || 'German'}, {neww} new words a day.</h2>
      <div style={{ fontFamily: T.sans, fontSize: 14.5, color: T.ink2, lineHeight: 1.5, maxWidth: 270, margin: '0 auto' }}>
        Your first session is ready — {neww} words, about {Math.max(2, Math.round(neww * 10 / 60))} minutes. Day one of your streak starts now.</div>
    </div>,
  ];

  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 80, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${TOPPAD}px 20px 0` }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 2, 3].map(i => <div key={i} style={{
          width: i === step ? 22 : 7, height: 7, borderRadius: 99, transition: 'all .25s',
          background: i <= step ? T.pine : T.hairStrong,
        }} />)}
      </div>
      <button onClick={onDone} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.sans, fontWeight: 700, fontSize: 14, color: T.ink3 }}>Skip</button>
    </div>
    <div className="mk-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 22px' }}>{steps[step]}</div>
    <div style={{ padding: '14px 22px 30px' }}>
      {step === 3
        ? <Btn full size="lg" icon="play" onClick={onStartSession}>Start learning</Btn>
        : <Btn full size="lg" onClick={next} disabled={step === 1 && !lang}>Continue</Btn>}
    </div>
  </div>;
}

Object.assign(window, { OnboardingScreen });
