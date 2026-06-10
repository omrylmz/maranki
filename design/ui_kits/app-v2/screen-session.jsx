/* Study session — the sacred loop.
   Chrome-minimal: thin ink progress line, the card centered with the rest of
   the queue visible as a stack beneath it. Tap to flip (3D), rate on the
   4-button scale with predicted intervals, undo every rating (A1), "Again"
   visibly requeues within the session, streak milestones celebrate quietly.
   Exiting with progress confirms and records a partial session. */

function RatingBtn({ label, interval, color, onClick }) {
  return <button onClick={onClick} style={{
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
    background: softTint(color, 11), border: `1px solid ${softTint(color, 28)}`,
    borderRadius: 14, padding: '12px 4px 10px', cursor: 'pointer', transition: 'transform .12s',
  }}
    onMouseDown={e => e.currentTarget.style.transform = 'scale(0.96)'}
    onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}>
    <span style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 14.5, color }}>{label}</span>
    <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.ink3 }}>{interval}</span>
  </button>;
}

function SessionScreen({ deckName = 'German — Everyday', onComplete, onExit }) {
  const { useState } = React;
  const [queue, setQueue] = useState(QUEUE);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [history, setHistory] = useState([]);   // [{queue, idx, counts, run}]
  const [counts, setCounts] = useState({ again: 0, hard: 0, good: 0, easy: 0 });
  const [run, setRun] = useState(4);            // correct-in-a-row (seeded mid-session feel)
  const [snack, setSnack] = useState(null);
  const [milestone, setMilestone] = useState(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const card = queue[idx];
  const total = queue.length;
  const reviewed = idx;

  const rate = (r) => {
    const snapshot = { queue, idx, counts, run };
    const nextCounts = { ...counts, [r]: counts[r] + 1 };
    let nextQueue = queue;
    if (r === 'again') {
      // requeue this card a few positions later, same session
      nextQueue = [...queue];
      const reinsert = Math.min(idx + 3, nextQueue.length);
      nextQueue.splice(reinsert, 0, { ...card, requeued: true });
    }
    const nextRun = r === 'again' ? 0 : run + 1;
    if (nextRun > 0 && nextRun % 5 === 0) {
      setMilestone(nextRun);
      setTimeout(() => setMilestone(null), 1600);
    }
    const labels = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
    setSnack({
      text: r === 'again'
        ? `${card.base} is coming back soon in this session`
        : `Rated ${labels[r]} · next in ${card.pred[r]}`,
      undo: true,
    });
    setHistory([...history, snapshot]);
    setCounts(nextCounts);
    setRun(nextRun);
    setRevealed(false);
    if (idx + 1 >= nextQueue.length) {
      onComplete({ counts: nextCounts, total: idx + 1, bestRun: Math.max(nextRun, 5) });
    } else {
      setQueue(nextQueue);
      setIdx(idx + 1);
    }
  };

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setQueue(prev.queue); setIdx(prev.idx); setCounts(prev.counts); setRun(prev.run);
    setRevealed(true);
    setSnack({ text: 'Rating undone — card restored', undo: false });
  };

  React.useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), 2600);
    return () => clearTimeout(t);
  }, [snack]);

  if (!card) return null;

  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 50, display: 'flex', flexDirection: 'column' }}>
    {/* ——— header ——— */}
    <div style={{ padding: `${TOPPAD}px 14px 0` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconBtn icon="close" size={36} iconSize={20} color={T.ink2}
          onClick={() => reviewed > 0 ? setConfirmExit(true) : onExit()} />
        <div style={{ flex: 1, textAlign: 'center' }}>
          <span style={{ fontFamily: T.mono, fontSize: 13.5, color: T.ink2, fontFeatureSettings: "'tnum' 1" }}>
            {idx + 1} <span style={{ color: T.ink3 }}>/ {total}</span></span>
        </div>
        <IconBtn icon="arrow-undo" size={36} iconSize={18} disabled={!history.length} onClick={undo} color={T.ink2} />
        <IconBtn icon="ellipsis-horizontal" size={36} iconSize={18} onClick={() => setMoreOpen(true)} color={T.ink2} />
      </div>
      <div style={{ margin: '8px 2px 0' }}>
        <Bar value={(idx) / total * 100} h={3} />
      </div>
    </div>

    {/* ——— the card ——— */}
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '12px 22px', position: 'relative' }}>
      {milestone && <div style={{
        position: 'absolute', top: 6, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 5,
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: T.amberTint, color: T.amberDeep,
          fontFamily: T.sans, fontWeight: 800, fontSize: 13.5, padding: '7px 14px', borderRadius: 999,
          animation: 'popIn .3s cubic-bezier(0.34,1.56,0.64,1)',
        }}><Ion name="flame" size={15} color={T.amber} />{milestone} in a row</span>
      </div>}

      <div style={{ position: 'relative' }}>
        {/* queue stack beneath */}
        <div style={{ position: 'absolute', left: 14, right: 14, bottom: -10, height: 30, background: T.card, border: `1px solid ${T.hair}`, borderRadius: 18, opacity: 0.55 }} />
        <div style={{ position: 'absolute', left: 7, right: 7, bottom: -5, height: 30, background: T.card, border: `1px solid ${T.hair}`, borderRadius: 18, opacity: 0.8 }} />

        <div key={card.id + '-' + idx} onClick={() => !revealed && setRevealed(true)} style={{
          position: 'relative', background: T.card, border: `1px solid ${T.hair}`, borderRadius: 20,
          boxShadow: T.shCard, minHeight: 330, display: 'flex', flexDirection: 'column',
          cursor: revealed ? 'default' : 'pointer', animation: 'riseIn .28s cubic-bezier(0.22,1,0.36,1)',
          padding: '18px 22px 20px', boxSizing: 'border-box',
        }}>
          {/* card top row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LevelBadge level={card.level} />
            {card.step && <Pill mono fg={T.amberDeep} bg={T.amberTint}>step {card.step}</Pill>}
            {card.requeued && <Pill fg={T.danger} bg={T.dangerTint}>again</Pill>}
            <div style={{ flex: 1 }} />
            <IconBtn icon="volume-high-outline" size={34} iconSize={18} color={T.pine} bg={T.pineTint}
              onClick={e => { e.stopPropagation(); setSnack({ text: `Playing “${card.base}”`, undo: false }); }} />
          </div>

          {!revealed ? (
            /* front — the word */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              {card.article && <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 21, color: T.amberDeep, marginBottom: 2 }}>{card.article}</div>}
              <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 42, letterSpacing: '-0.015em', color: T.ink, lineHeight: 1.05 }}>
                {card.base}</div>
              <div style={{ fontFamily: T.mono, fontSize: 14, color: T.ink3, marginTop: 10, whiteSpace: 'nowrap' }}>{card.ipa}</div>
              <div style={{
                marginTop: 34, display: 'inline-flex', alignItems: 'center', gap: 6,
                fontFamily: T.sans, fontSize: 12.5, fontWeight: 650, color: T.ink3,
              }}><Ion name="hand-left-outline" size={14} />Tap to reveal</div>
            </div>
          ) : (
            /* back — the answer */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', animation: 'fadeIn .22s' }}>
              <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 14.5, color: T.ink3 }}>{card.word}</div>
              <div style={{ width: 36, height: 1, background: T.hairStrong, margin: '13px 0' }} />
              <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 31, letterSpacing: '-0.015em', color: T.ink, lineHeight: 1.12 }}>
                {card.tr}</div>
              <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 16.5, color: T.ink2, marginTop: 18, lineHeight: 1.45 }}>
                {card.ex}</div>
              <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3, marginTop: 4 }}>{card.exTr}</div>
              <div style={{ marginTop: 16 }}><Pill>{card.type}</Pill></div>
            </div>
          )}
        </div>
      </div>
    </div>

    {/* ——— rating zone (stable height) ——— */}
    <div style={{ padding: `0 18px ${26}px`, minHeight: 96, boxSizing: 'border-box' }}>
      {revealed ? (
        <div style={{ display: 'flex', gap: 9, animation: 'riseIn .2s cubic-bezier(0.22,1,0.36,1)' }}>
          <RatingBtn label="Again" interval={card.pred.again} color={T.rateAgain} onClick={() => rate('again')} />
          <RatingBtn label="Hard" interval={card.pred.hard} color={T.rateHard} onClick={() => rate('hard')} />
          <RatingBtn label="Good" interval={card.pred.good} color={T.rateGood} onClick={() => rate('good')} />
          <RatingBtn label="Easy" interval={card.pred.easy} color={T.rateEasy} onClick={() => rate('easy')} />
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: 62,
          fontFamily: T.sans, fontSize: 13, color: T.ink3, gap: 14,
        }}>
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}><Ion name="bulb-outline" size={15} />Hint</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>swipe to rate after revealing</span>
        </div>
      )}
    </div>

    {snack && <Snackbar text={snack.text} onUndo={snack.undo ? undo : null} />}

    {/* per-card actions */}
    <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={card.base}>
      <ListRow icon="repeat" title="Reschedule" sub="Set when you'll see this next · difficulty unchanged" onClick={() => { setMoreOpen(false); setSnack({ text: 'Reschedule — pick the next review date', undo: false }); }} />
      <ListRow icon="eye-off-outline" title="Bury for now" sub="Skip today without changing its schedule" onClick={() => { setMoreOpen(false); setSnack({ text: `${card.base} buried until tomorrow`, undo: true }); }} />
      <ListRow icon="flag-outline" title="Flag" sub="Bookmark for later — no effect on scheduling" onClick={() => { setMoreOpen(false); setSnack({ text: `${card.base} flagged`, undo: true }); }} />
      <ListRow icon="swap-horizontal" title="Switch mode" sub="Flashcard · typing · multiple choice" onClick={() => { setMoreOpen(false); setSnack({ text: 'Mode switch — flashcard · typing · quiz', undo: false }); }} last />
    </Sheet>

    {/* exit confirm */}
    <Sheet open={confirmExit} onClose={() => setConfirmExit(false)} title="End this session?">
      <div style={{ fontFamily: T.sans, fontSize: 14.5, color: T.ink2, marginBottom: 18, lineHeight: 1.5 }}>
        The {reviewed} {reviewed === 1 ? 'card' : 'cards'} you reviewed will be saved.</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="secondary" full onClick={() => setConfirmExit(false)}>Keep studying</Btn>
        <Btn full onClick={() => { setConfirmExit(false); onExit(); }}>End session</Btn>
      </div>
    </Sheet>
  </div>;
}

Object.assign(window, { SessionScreen, RatingBtn });
