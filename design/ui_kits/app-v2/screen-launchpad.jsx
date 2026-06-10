/* Study — the launchpad (B1). One place to *do*: an aggregate "study now"
   command, then every studiable object — decks and collections — as a row
   with an honest due count and a one-tap study action. Paused decks sit in
   a disclosure. The universal peek sheet (Study / Browse cards / Edit)
   replaces hidden long-presses; the FAB opens the global create menu (B2). */

function LaunchpadScreen({ onStartSession, onPeek, onStudy, onCreate, onImport, onSnack }) {
  const { useState } = React;
  const [showPaused, setShowPaused] = useState(false);
  const active = DECKS.filter(d => d.active);
  const paused = DECKS.filter(d => !d.active);

  return <Page>
    <ScreenHead title="Study" sub="Pick what to review — or just start."
      right={<IconBtn icon="cloud-download-outline" size={36} iconSize={18} border onClick={onImport} />} />

    {/* aggregate command */}
    <Card onClick={onStartSession} style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px' }}>
      <div style={{
        width: 46, height: 46, borderRadius: 999, background: T.pine, display: 'flex',
        alignItems: 'center', justifyContent: 'center', flex: 'none', boxShadow: T.shSm,
      }}><Ion name="play" size={20} color="#fff" /></div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 16, color: T.ink }}>Study now</div>
        <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink2, fontFeatureSettings: "'tnum' 1" }}>
          {READY.total} ready across {active.length} decks · ~{READY.mins} min</div>
      </div>
      <Ion name="chevron-forward" size={17} color={T.ink3} />
    </Card>

    {/* decks */}
    <SectionHead>Decks</SectionHead>
    <div>
      {active.map((d, i) => (
        <Row key={d.id} onClick={() => onPeek(d)} pad="14px 0" last={i === active.length - 1 && !paused.length}>
          <FlagSq flag={d.flag} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 15, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
              {!d.builtin && <Pill fg={T.info} bg={T.infoTint}>imported</Pill>}
            </div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 2, fontFeatureSettings: "'tnum' 1" }}>
              {d.total.toLocaleString('en-US')} cards{d.due > 0 ? ` · ${d.due} due` : ' · caught up'}</div>
          </div>
          {d.due > 0
            ? <Btn size="sm" onClick={e => { e.stopPropagation(); onStudy(d); }}>Study {d.due}</Btn>
            : <Ion name="checkmark-circle" size={19} color={T.success} style={{ opacity: 0.65 }} />}
        </Row>
      ))}
      {paused.length > 0 && <div>
        <button onClick={() => setShowPaused(!showPaused)} style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
          cursor: 'pointer', padding: '13px 0', fontFamily: T.sans, fontWeight: 650, fontSize: 13.5, color: T.ink3, width: '100%',
        }}>
          <Ion name={showPaused ? 'chevron-down' : 'chevron-forward'} size={14} />
          Paused ({paused.length})
        </button>
        {showPaused && paused.map((d, i) => (
          <Row key={d.id} onClick={() => onPeek(d)} pad="12px 0" last={i === paused.length - 1} style={{ opacity: 0.75 }}>
            <FlagSq flag={d.flag} size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 14.5, color: T.ink2 }}>{d.name}</div>
              <div style={{ fontFamily: T.sans, fontSize: 12, color: T.ink3, fontFeatureSettings: "'tnum' 1" }}>{d.total.toLocaleString('en-US')} cards</div>
            </div>
            <Btn size="sm" kind="secondary" onClick={e => { e.stopPropagation(); onSnack(`${d.name} resumed — its cards rejoin your queue`); }}>Resume</Btn>
          </Row>
        ))}
      </div>}
    </div>

    {/* collections */}
    <SectionHead actionLabel="+ New" onAction={onCreate}>Collections</SectionHead>
    <div>
      {COLLECTIONS.map((c, i) => (
        <Row key={c.id} onClick={() => onPeek({ ...c, isCollection: true })} pad="13px 0" last={i === COLLECTIONS.length - 1}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, background: T.pineTint,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
          }}><Ion name={c.icon} size={17} color={T.pine} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 15, color: T.ink }}>{c.name}</div>
            <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 1, fontFeatureSettings: "'tnum' 1" }}>
              {c.count} cards · {c.due} due</div>
          </div>
          {c.due > 0
            ? <Btn size="sm" kind="secondary" onClick={e => { e.stopPropagation(); onStudy(c); }}>Study {c.due}</Btn>
            : <Ion name="checkmark-circle" size={19} color={T.success} style={{ opacity: 0.65 }} />}
        </Row>
      ))}
    </div>

    <FAB onClick={onCreate} />
  </Page>;
}

/* ——— universal object peek (B1): tap any deck/collection anywhere ——— */
function PeekSheet({ obj, onClose, onStudy, onBrowse, onEdit }) {
  if (!obj) return null;
  const isColl = obj.isCollection;
  return <Sheet open={!!obj} onClose={onClose}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 4 }}>
      {isColl
        ? <div style={{ width: 44, height: 44, borderRadius: 12, background: T.pineTint, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Ion name={obj.icon} size={20} color={T.pine} /></div>
        : <FlagSq flag={obj.flag} size={44} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 21, color: T.ink, lineHeight: 1.15 }}>{obj.name}</div>
        <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3, marginTop: 2, fontFeatureSettings: "'tnum' 1" }}>
          {(obj.total || obj.count).toLocaleString('en-US')} cards{obj.due > 0 ? ` · ${obj.due} due now` : ' · caught up'}</div>
      </div>
    </div>
    {!isColl && <div style={{ margin: '14px 0 4px' }}>
      <SegBar mastered={obj.mastered} learning={obj.learning} neww={obj.neww} total={obj.total} h={5} />
      <div style={{ display: 'flex', gap: 14, marginTop: 8, fontFamily: T.sans, fontSize: 12, color: T.ink3 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: T.pine }} />Mastered {obj.mastered}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: T.amber }} />Learning {obj.learning}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: T.info, opacity: 0.6 }} />New {obj.neww}</span>
      </div>
    </div>}
    {isColl && <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 14.5, color: T.ink2, margin: '6px 0 2px' }}>{obj.desc}</div>}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
      <Btn full size="lg" icon="play" onClick={onStudy} disabled={!obj.due}>
        {obj.due > 0 ? `Study ${obj.due} due` : 'Nothing due — study ahead'}</Btn>
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="secondary" full icon="search" onClick={onBrowse}>Browse cards</Btn>
        <Btn kind="secondary" full icon="pencil" onClick={onEdit}>Edit</Btn>
      </div>
    </div>
  </Sheet>;
}

/* ——— global create menu (B2) ——— */
function CreateSheet({ open, onClose, onNewCard, onNewDeck, onNewCollection, onImport }) {
  return <Sheet open={open} onClose={onClose} title="Create">
    <ListRow icon="document-text-outline" title="New card" sub="Add a word to any deck" onClick={onNewCard} />
    <ListRow icon="albums-outline" title="New deck" sub="A fresh collection of cards" onClick={onNewDeck} />
    <ListRow icon="funnel-outline" title="New collection" sub="A saved smart filter — always up to date" onClick={onNewCollection} />
    <div style={{ height: 1, background: T.hairStrong, margin: '6px 0' }} />
    <ListRow icon="cloud-download-outline" iconColor={T.info} iconBg={T.infoTint} title="Import" sub="CSV · Anki file · AnkiWeb" onClick={onImport} last />
  </Sheet>;
}

Object.assign(window, { LaunchpadScreen, PeekSheet, CreateSheet });
