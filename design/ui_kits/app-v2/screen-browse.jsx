/* Library (Browse) — search, inspect, organize (B1: browse = manage).
   Free-text search with discoverable filter tokens, state-dot ledger rows,
   the universal card peek (audio, example, toggles, pronunciation, edit),
   multi-select with a bulk action bar (B8), and cause-split empty states (B7). */

function BrowseScreen({ onEditCard, onCreate, onSnack }) {
  const { useState, useMemo } = React;
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');
  const [peek, setPeek] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState([]);
  const [filterOpen, setFilterOpen] = useState(false);

  const cards = useMemo(() => {
    let c = LIB;
    if (chip === 'due') c = c.filter(x => x.state === 'due' || x.state === 'learning');
    if (chip === 'new') c = c.filter(x => x.state === 'new');
    if (chip === 'fav') c = c.filter(x => x.fav);
    if (q) {
      const s = q.toLowerCase();
      c = c.filter(x => x.word.toLowerCase().includes(s) || x.tr.toLowerCase().includes(s) || (x.ex || '').toLowerCase().includes(s));
    }
    return c;
  }, [q, chip]);

  const toggleSel = id => setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const bulk = label => {
    onSnack(`${sel.length} cards ${label}`);
    setSel([]); setSelecting(false);
  };

  return <Page>
    <ScreenHead title="Library" sub={`${PERSON.totalCards.toLocaleString('en-US')} cards across ${DECKS.length} decks`}
      right={selecting
        ? <Btn size="sm" kind="quiet" onClick={() => { setSelecting(false); setSel([]); }}>Cancel</Btn>
        : <Btn size="sm" kind="quiet" onClick={() => setSelecting(true)}>Select</Btn>} />

    {/* search */}
    <div style={{
      display: 'flex', alignItems: 'center', gap: 9, background: T.card, border: `1px solid ${T.hairStrong}`,
      borderRadius: 999, padding: '11px 16px', marginTop: 12,
    }}>
      <Ion name="search" size={17} color={T.ink3} />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search words, meanings, examples…"
        style={{ flex: 1, border: 'none', background: 'none', fontFamily: T.sans, fontSize: 14.5, color: T.ink }} />
      {q && <Ion name="close-circle" size={17} color={T.ink3} style={{ cursor: 'pointer' }} onClick={() => setQ('')} />}
    </div>
    <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.ink3, margin: '8px 2px 0' }}>
      try <span style={{ color: T.pine }}>level:B1</span> · <span style={{ color: T.pine }}>type:verb</span> · <span style={{ color: T.pine }}>deck:"Spanish — Travel"</span></div>

    {/* scope chips */}
    <div className="mk-scroll" style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '14px 0 2px' }}>
      <Chip active={chip === 'all'} onClick={() => setChip('all')}>All cards</Chip>
      <Chip active={chip === 'due'} icon="time-outline" onClick={() => setChip('due')}>Due</Chip>
      <Chip active={chip === 'new'} icon="sparkles-outline" onClick={() => setChip('new')}>New</Chip>
      <Chip active={chip === 'fav'} icon="heart-outline" onClick={() => setChip('fav')}>Favorites</Chip>
      <Chip icon="options-outline" onClick={() => setFilterOpen(true)}>Filters</Chip>
    </div>

    {/* results */}
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 2px' }}>
      <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, fontFeatureSettings: "'tnum' 1", whiteSpace: 'nowrap' }}>
        {cards.length} {cards.length === 1 ? 'card' : 'cards'} · sorted smart</span>
      <button onClick={() => onSnack('Sort — smart · A–Z · newest · hardest')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.sans, fontSize: 12.5, fontWeight: 700, color: T.pine, display: 'flex', gap: 4, alignItems: 'center' }}>
        <Ion name="swap-vertical" size={13} />Sort</button>
    </div>

    {cards.length === 0 ? (
      <div style={{ textAlign: 'center', padding: '46px 20px' }}>
        <Ion name="search" size={34} color={T.ink3} />
        <div style={{ fontFamily: T.serif, fontSize: 19, color: T.ink, margin: '12px 0 5px' }}>No matches{q ? ` for “${q}”` : ''}</div>
        <div style={{ fontFamily: T.sans, fontSize: 13.5, color: T.ink3, marginBottom: 16 }}>Your cards are still here — the current search and filters exclude them.</div>
        <Btn kind="secondary" onClick={() => { setQ(''); setChip('all'); }}>Clear search & filters</Btn>
      </div>
    ) : (
      <div>
        {cards.map((c, i) => (
          <Row key={c.id} pad="13px 0" last={i === cards.length - 1}
            onClick={() => selecting ? toggleSel(c.id) : setPeek(c)}>
            {selecting && <div style={{
              width: 22, height: 22, borderRadius: 7, flex: 'none', boxSizing: 'border-box',
              border: sel.includes(c.id) ? 'none' : `1.5px solid ${T.hairStrong}`,
              background: sel.includes(c.id) ? T.pine : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{sel.includes(c.id) && <Ion name="checkmark" size={14} color="#fff" />}</div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 17.5, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.word}</span>
                <StateDot state={c.state} />
              </div>
              <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink2, marginTop: 1 }}>{c.tr}</div>
            </div>
            <LevelBadge level={c.level} />
            {c.fav
              ? <Ion name="heart" size={16} color={T.danger} />
              : c.interval
                ? <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.ink3, minWidth: 28, textAlign: 'right' }}>{c.interval}</span>
                : <span style={{ minWidth: 16 }} />}
          </Row>
        ))}
      </div>
    )}

    {!selecting && <FAB onClick={onCreate} />}

    {/* bulk action bar */}
    {selecting && sel.length > 0 && <div style={{
      position: 'absolute', left: 14, right: 14, bottom: TABH + 12, zIndex: 55,
      background: T.inverseSurface, borderRadius: 16, padding: '11px 14px', boxShadow: T.shLg,
      display: 'flex', alignItems: 'center', gap: 6, animation: 'snackIn .22s cubic-bezier(0.22,1,0.36,1)',
    }}>
      <span style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 13.5, color: T.inverseText, marginRight: 4, fontFeatureSettings: "'tnum' 1" }}>{sel.length}</span>
      {[['heart-outline', 'favorited', 'Favorite'], ['flag-outline', 'flagged', 'Flag'], ['eye-off-outline', 'suspended', 'Suspend']].map(([ic, verb, label]) =>
        <button key={ic} title={label} onClick={() => bulk(verb)} style={{
          flex: 1, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, padding: '8px 0',
          cursor: 'pointer', display: 'flex', justifyContent: 'center',
        }}><Ion name={ic} size={17} color={T.inverseText} /></button>)}
      <button onClick={() => bulk('queued to study')} style={{
        flex: 1.6, background: T.inverseAccent, border: 'none', borderRadius: 10, padding: '8px 0', cursor: 'pointer',
        fontFamily: T.sans, fontWeight: 800, fontSize: 12.5, color: '#3A2A08',
      }}>Study these</button>
    </div>}

    {/* card peek */}
    <CardPeek card={peek} onClose={() => setPeek(null)} onEdit={() => { const c = peek; setPeek(null); onEditCard(c); }} onSnack={onSnack} />

    {/* filter sheet */}
    <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filters">
      <Overline style={{ marginBottom: 8 }}>Level</Overline>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
        {['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(l => <Chip key={l}>{l}</Chip>)}
      </div>
      <Overline style={{ marginBottom: 8 }}>Status</Overline>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
        {['New', 'Learning', 'Due', 'Mastered', 'Suspended', 'Flagged'].map(s => <Chip key={s}>{s}</Chip>)}
      </div>
      <Overline style={{ marginBottom: 8 }}>Deck</Overline>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 20 }}>
        {DECKS.map(d => <Chip key={d.id}>{d.flag} {d.name}</Chip>)}
      </div>
      <Btn full onClick={() => setFilterOpen(false)}>Show results</Btn>
    </Sheet>
  </Page>;
}

/* ——— card peek — the universal card detail ——— */
function CardPeek({ card, onClose, onEdit, onSnack }) {
  if (!card) return null;
  return <Sheet open={!!card} onClose={onClose}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 28, letterSpacing: '-0.015em', color: T.ink, lineHeight: 1.1 }}>{card.word}</div>
        <div style={{ fontFamily: T.mono, fontSize: 13, color: T.ink3, marginTop: 5, whiteSpace: 'nowrap' }}>{card.ipa}</div>
      </div>
      <IconBtn icon="volume-high-outline" size={38} iconSize={19} color={T.pine} bg={T.pineTint} onClick={() => onSnack(`Playing “${card.word}”`)} />
    </div>
    <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 17, color: T.ink, margin: '12px 0 2px' }}>{card.tr}</div>
    {card.ex && <div style={{ margin: '10px 0 0' }}>
      <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 15.5, color: T.ink2, lineHeight: 1.45 }}>{card.ex}</div>
      <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 2 }}>{card.exTr}</div>
    </div>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '14px 0 4px', flexWrap: 'wrap' }}>
      <StateBadge state={card.state} label={card.state} />
      <LevelBadge level={card.level} />
      <Pill>{card.type}</Pill>
      {card.interval && <Pill mono>next in {card.interval}</Pill>}
    </div>
    <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
      {[['heart-outline', 'Favorite'], ['school-outline', 'Learning'], ['checkmark-circle-outline', 'Learned']].map(([ic, label]) =>
        <button key={label} onClick={() => onSnack(`Marked ${label.toLowerCase()}`)} style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          background: T.paperSunk, border: 'none', borderRadius: 12, padding: '11px 0', cursor: 'pointer',
        }}>
          <Ion name={ic} size={18} color={T.ink2} />
          <span style={{ fontFamily: T.sans, fontSize: 11.5, fontWeight: 650, color: T.ink2 }}>{label}</span>
        </button>)}
    </div>
    <div style={{ display: 'flex', gap: 10 }}>
      <Btn kind="secondary" full icon="mic-outline" onClick={() => onSnack('Pronunciation practice — record & compare')}>Say it</Btn>
      <Btn full icon="pencil" onClick={onEdit}>Edit card</Btn>
    </div>
  </Sheet>;
}

Object.assign(window, { BrowseScreen, CardPeek });
