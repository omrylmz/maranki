/* Editors — card & deck, with safety built in (B9, C4).
   Unsaved-changes guard on back, Save disabled until valid, a real
   Pronunciation section (IPA + record/playback — the unmounted subsystem,
   surfaced), and a deck delete that offers keep / move / delete-all. */

function CardEditor({ card, deckId, onBack, onSnack }) {
  const { useState } = React;
  const editing = !!card;
  const [word, setWord] = useState(card?.word || '');
  const [tr, setTr] = useState(card?.tr || '');
  const [ex, setEx] = useState(card?.ex || '');
  const [ipa, setIpa] = useState(card?.ipa || '');
  const [level, setLevel] = useState(card?.level || null);
  const [type, setType] = useState(card?.type || null);
  const [deck, setDeck] = useState(card ? 'de-a1' : (deckId || 'de-a1'));
  const [recorded, setRecorded] = useState(editing);
  const [recording, setRecording] = useState(false);
  const [guard, setGuard] = useState(false);

  const dirty = editing
    ? (word !== card.word || tr !== card.tr || ex !== (card.ex || '') || ipa !== (card.ipa || ''))
    : (word || tr || ex || ipa);
  const valid = word.trim() && tr.trim();

  const record = () => {
    setRecording(true);
    setTimeout(() => { setRecording(false); setRecorded(true); }, 1500);
  };

  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 55 }}>
    <StackBar title={editing ? 'Edit card' : 'New card'} backIcon="close"
      onBack={() => dirty ? setGuard(true) : onBack()}
      right={<Btn size="sm" disabled={!valid} onClick={() => { onSnack(editing ? 'Card saved' : `“${word}” added`); onBack(); }}>Save</Btn>} />
    <div className="mk-scroll" style={{ position: 'absolute', top: TOPPAD + 48, bottom: 0, left: 0, right: 0, overflowY: 'auto', padding: '18px 20px 40px' }}>
      <Field label="Word *" value={word} onChange={setWord} placeholder="die Stunde" autoFocus={!editing} />
      <Field label="Translation *" value={tr} onChange={setTr} placeholder="the hour" />
      <Field label="Example" value={ex} onChange={setEx} placeholder="Wir treffen uns in einer Stunde." multiline
        hint="Shown in italic on the card back — real language, quoted." />

      {/* pronunciation — the surfaced subsystem (C4) */}
      <Overline style={{ margin: '4px 0 7px' }}>Pronunciation</Overline>
      <div style={{ background: T.card, border: `1px solid ${T.hairStrong}`, borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}>
        <input value={ipa} onChange={e => setIpa(e.target.value)} placeholder="/ˈʃtʊndə/ (IPA, optional)"
          style={{ width: '100%', border: 'none', background: 'none', fontFamily: T.mono, fontSize: 14.5, color: T.ink, boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.hairSoft}` }}>
          {recording ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: T.sans, fontSize: 13.5, fontWeight: 700, color: T.danger }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: T.danger, animation: 'pulseSoft 1s infinite' }} />Recording… tap to stop
            </span>
          ) : recorded ? (
            <React.Fragment>
              <IconBtn icon="play" size={32} iconSize={15} color={T.pine} bg={T.pineTint} />
              <span style={{ flex: 1, fontFamily: T.sans, fontSize: 13, color: T.ink2 }}>Your recording · 0:02</span>
              <Btn size="sm" kind="quiet" icon="mic-outline" onClick={record}>Re-record</Btn>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <Btn size="sm" kind="secondary" icon="mic-outline" onClick={record}>Record yourself</Btn>
              <span style={{ fontFamily: T.sans, fontSize: 12, color: T.ink3 }}>compare with the native audio</span>
            </React.Fragment>
          )}
        </div>
      </div>

      <Overline style={{ margin: '4px 0 7px' }}>Deck</Overline>
      <div className="mk-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', marginBottom: 16 }}>
        {DECKS.filter(d => d.active).map(d => <Chip key={d.id} active={deck === d.id} onClick={() => setDeck(d.id)}>{d.flag} {d.name}</Chip>)}
      </div>

      <Overline style={{ margin: '4px 0 7px' }}>Level</Overline>
      <div style={{ display: 'flex', gap: 7, marginBottom: 16 }}>
        {['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(l => <Chip key={l} active={level === l} onClick={() => setLevel(level === l ? null : l)}>{l}</Chip>)}
      </div>

      <Overline style={{ margin: '4px 0 7px' }}>Type</Overline>
      <div className="mk-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', marginBottom: 20 }}>
        {['noun', 'verb', 'adjective', 'adverb', 'phrase', 'preposition', 'other'].map(t =>
          <Chip key={t} active={type === t} onClick={() => setType(type === t ? null : t)}>{t}</Chip>)}
      </div>

      {editing && <div style={{ border: `1px solid ${softTint(T.danger, 30)}`, borderRadius: 14, padding: '2px 14px', background: softTint(T.danger, 4), marginTop: 8 }}>
        <ListRow icon="trash-outline" danger title="Delete this card" sub="Its scheduling history goes with it" last
          onClick={() => { onSnack(`“${card.word}” deleted`); onBack(); }} />
      </div>}
    </div>

    {/* unsaved-changes guard (B9) */}
    <Sheet open={guard} onClose={() => setGuard(false)} title="Discard changes?">
      <div style={{ fontFamily: T.sans, fontSize: 14.5, color: T.ink2, marginBottom: 18 }}>Your edits to this card haven’t been saved.</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="secondary" full onClick={() => setGuard(false)}>Keep editing</Btn>
        <Btn kind="danger" full onClick={() => { setGuard(false); onBack(); }}>Discard</Btn>
      </div>
    </Sheet>
  </div>;
}

function DeckEditor({ deck, onBack, onSnack }) {
  const { useState } = React;
  const editing = !!deck;
  const [name, setName] = useState(deck?.name || '');
  const [lang, setLang] = useState(deck?.lang || null);
  const [desc, setDesc] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const [delMode, setDelMode] = useState('move');

  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 55 }}>
    <StackBar title={editing ? 'Edit deck' : 'New deck'} backIcon="close" onBack={onBack}
      right={<Btn size="sm" disabled={!name.trim()} onClick={() => { onSnack(editing ? 'Deck saved' : `Deck “${name}” created`); onBack(); }}>Save</Btn>} />
    <div className="mk-scroll" style={{ position: 'absolute', top: TOPPAD + 48, bottom: 0, left: 0, right: 0, overflowY: 'auto', padding: '18px 20px 40px' }}>
      <Field label="Deck name *" value={name} onChange={setName} placeholder="Spanish — Kitchen verbs" autoFocus={!editing} />
      <Overline style={{ margin: '4px 0 7px' }}>Language</Overline>
      <div className="mk-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', marginBottom: 16 }}>
        {['German', 'Spanish', 'French', 'Italian', 'Other'].map(l => <Chip key={l} active={lang === l} onClick={() => setLang(l)}>{l}</Chip>)}
      </div>
      <Field label="Description" value={desc} onChange={setDesc} placeholder="What lives in this deck?" multiline />

      {editing && <React.Fragment>
        <Btn kind="secondary" full icon="copy-outline" style={{ marginTop: 4 }}
          onClick={() => { onSnack(`Copied as “${deck.name} (copy)” — fresh cards, no progress`); }}>
          Duplicate deck</Btn>
        <div style={{ border: `1px solid ${softTint(T.danger, 30)}`, borderRadius: 14, padding: '2px 14px', background: softTint(T.danger, 4), marginTop: 18 }}>
          <ListRow icon="trash-outline" danger title="Delete this deck" sub={`${deck.total.toLocaleString('en-US')} cards — choose what happens to them`} last
            onClick={() => setDelOpen(true)} />
        </div>
      </React.Fragment>}
    </div>

    {/* safe delete: keep / move / delete-all (B9) */}
    <Sheet open={delOpen} onClose={() => setDelOpen(false)} title={`Delete “${deck?.name}”?`}>
      <div style={{ fontFamily: T.sans, fontSize: 14, color: T.ink2, marginBottom: 14 }}>
        What should happen to its {deck?.total.toLocaleString('en-US')} cards?</div>
      {[
        { id: 'move', icon: 'arrow-redo-outline', t: 'Move cards to another deck', s: 'Keeps every card and its progress' },
        { id: 'keep', icon: 'archive-outline', t: 'Keep cards, remove the deck', s: 'Cards stay in your library, unassigned' },
        { id: 'all', icon: 'trash-outline', t: 'Delete deck and all its cards', s: 'Permanent — scheduling history is lost' },
      ].map(o => (
        <Row key={o.id} onClick={() => setDelMode(o.id)} pad="11px 0">
          <div style={{
            width: 20, height: 20, borderRadius: 99, flex: 'none', boxSizing: 'border-box',
            border: delMode === o.id ? `6px solid ${o.id === 'all' ? T.danger : T.pine}` : `1.5px solid ${T.hairStrong}`,
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 14, color: o.id === 'all' ? T.danger : T.ink }}>{o.t}</div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3 }}>{o.s}</div>
          </div>
        </Row>
      ))}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <Btn kind="secondary" full onClick={() => setDelOpen(false)}>Cancel</Btn>
        <Btn kind={delMode === 'all' ? 'dangerSolid' : 'primary'} full
          onClick={() => { setDelOpen(false); onSnack(delMode === 'all' ? 'Deck and cards deleted' : 'Deck deleted — cards kept'); onBack(); }}>
          {delMode === 'all' ? 'Delete everything' : 'Delete deck'}</Btn>
      </div>
    </Sheet>
  </div>;
}

Object.assign(window, { CardEditor, DeckEditor });
