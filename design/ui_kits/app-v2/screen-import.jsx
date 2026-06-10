/* Import hub (B6) — one destination, three sources (file / AnkiWeb / backup),
   a shared staged flow with an honest preview, cancellable progress, and a
   "Go study" forward action at the end. AnkiWeb search lives in-app (B6b). */

function ImportScreen({ onBack, onSnack, onStudy }) {
  const { useState, useEffect } = React;
  const [src, setSrc] = useState('anki');
  const [stage, setStage] = useState('idle');   // idle | preview | importing | done
  const [prog, setProg] = useState(0);
  const [q, setQ] = useState('');

  const results = [
    { name: 'German Top 4000 Vocabulary', cards: 4044, cat: 'German', by: 'AnkiWeb' },
    { name: 'Goethe-Institut A1 Wortliste', cards: 650, cat: 'German', by: 'AnkiWeb' },
    { name: 'German Sentences — B1/B2', cards: 2980, cat: 'German', by: 'AnkiWeb' },
  ].filter(r => !q || r.name.toLowerCase().includes(q.toLowerCase()));

  /* pasted AnkiWeb URL or numeric deck ID → straight to preview (B6b) */
  const pastedId = /^(https?:\/\/|ankiweb\.|\d{6,})/i.test(q.trim());

  useEffect(() => {
    if (stage !== 'importing') return;
    setProg(0);
    const t = setInterval(() => setProg(p => {
      if (p >= 100) { clearInterval(t); setStage('done'); return 100; }
      return p + 4;
    }), 60);
    return () => clearInterval(t);
  }, [stage]);

  return <div style={{ position: 'absolute', inset: 0, background: T.paper, zIndex: 55 }}>
    <StackBar title="Import" sub="Bring your own vocabulary" backIcon="close" onBack={onBack} />
    <div className="mk-scroll" style={{ position: 'absolute', top: TOPPAD + 52, bottom: 0, left: 0, right: 0, overflowY: 'auto', padding: '16px 20px 40px' }}>

      {stage === 'idle' && <React.Fragment>
        <SegCtrl value={src} onChange={setSrc} options={[
          { id: 'anki', label: 'AnkiWeb' }, { id: 'file', label: 'From a file' }, { id: 'backup', label: 'Backup' },
        ]} />

        {src === 'anki' && <div style={{ marginTop: 18 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 9, background: T.card, border: `1px solid ${T.hairStrong}`,
            borderRadius: 999, padding: '11px 16px',
          }}>
            <Ion name="search" size={16} color={T.ink3} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search shared decks…"
              style={{ flex: 1, border: 'none', background: 'none', fontFamily: T.sans, fontSize: 14.5, color: T.ink }} />
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, margin: '10px 2px 4px' }}>
            {pastedId ? 'From your link' : 'Popular for German learners'}</div>
          {pastedId && (
            <Row onClick={() => setStage('preview')} pad="13px 0" last={results.length === 0}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: T.pineTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <Ion name="link-outline" size={17} color={T.pine} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink }}>Import from AnkiWeb</div>
                <div style={{ fontFamily: T.mono, fontSize: 12, color: T.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.trim()}</div>
              </div>
              <Ion name="chevron-forward" size={16} color={T.ink3} />
            </Row>
          )}
          {results.map((r, i) => (
            <Row key={r.name} onClick={() => setStage('preview')} pad="13px 0" last={i === results.length - 1}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: T.infoTint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <Ion name="albums-outline" size={17} color={T.info} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 14.5, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, fontFeatureSettings: "'tnum' 1" }}>{r.cards.toLocaleString('en-US')} cards · {r.cat}</div>
              </div>
              <Ion name="chevron-forward" size={16} color={T.ink3} />
            </Row>
          ))}
          {results.length === 0 && !pastedId && (
            <div style={{ textAlign: 'center', padding: '26px 16px' }}>
              <div style={{ fontFamily: T.serif, fontSize: 17, color: T.ink, marginBottom: 4 }}>No shared decks match</div>
              <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3 }}>Try another search — or paste an AnkiWeb URL / deck ID.</div>
            </div>
          )}
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 14, textAlign: 'center' }}>
            or paste an AnkiWeb URL / deck ID above</div>
        </div>}

        {src === 'file' && <div style={{ marginTop: 18 }}>
          <button onClick={() => setStage('preview')} style={{
            width: '100%', border: `1.5px dashed ${T.hairStrong}`, borderRadius: 16, background: 'transparent',
            padding: '34px 20px', cursor: 'pointer', textAlign: 'center',
          }}>
            <Ion name="document-attach-outline" size={30} color={T.ink3} />
            <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 15, color: T.ink, margin: '10px 0 4px' }}>Choose a file</div>
            <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3 }}>.csv or .apkg — we’ll detect which</div>
          </button>
          <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 12, lineHeight: 1.5 }}>
            CSV columns map to Word, Translation, Example, Level, Type, Pronunciation and Tags — you’ll confirm the mapping before anything is written.</div>
        </div>}

        {src === 'backup' && <div style={{ marginTop: 18 }}>
          <ListRow icon="refresh-circle-outline" title="Restore a Maranki backup" sub="A .json file from Settings → Export" last
            onClick={() => onSnack('Choose a backup file')} />
        </div>}
      </React.Fragment>}

      {stage === 'preview' && <div style={{ animation: 'riseIn .25s cubic-bezier(0.22,1,0.36,1)' }}>
        <Overline style={{ marginBottom: 10 }}>Preview — nothing imported yet</Overline>
        <Card>
          <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 20, color: T.ink, marginBottom: 12 }}>German Top 4000 Vocabulary</div>
          {[['Cards', '4,044'], ['With study progress', '1,212'], ['Audio & images', '388 files'], ['Already in your library', '36 duplicates — will be skipped']].map(([l, n], i, arr) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < arr.length - 1 ? `1px solid ${T.hairSoft}` : 'none' }}>
              <span style={{ fontFamily: T.sans, fontSize: 13.5, color: T.ink2 }}>{l}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{n}</span>
            </div>
          ))}
        </Card>
        <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, margin: '12px 2px' }}>
          Anki scheduling is preserved — ease, intervals and due dates come along.</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <Btn kind="secondary" full onClick={() => setStage('idle')}>Cancel</Btn>
          <Btn full icon="cloud-download-outline" onClick={() => setStage('importing')}>Import deck</Btn>
        </div>
      </div>}

      {stage === 'importing' && <div style={{ textAlign: 'center', padding: '40px 10px' }}>
        <Ring value={prog} size={86} stroke={6}>
          <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 19, color: T.ink, fontFeatureSettings: "'tnum' 1" }}>{prog}%</span>
        </Ring>
        <div style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 15.5, color: T.ink, margin: '18px 0 4px' }}>Importing 4,044 cards…</div>
        <div style={{ fontFamily: T.sans, fontSize: 13, color: T.ink3, marginBottom: 22 }}>Keeping your Anki scheduling intact.</div>
        <Btn kind="quiet" onClick={() => { setStage('idle'); onSnack('Import cancelled — nothing was written'); }}>Cancel</Btn>
      </div>}

      {stage === 'done' && <div style={{ textAlign: 'center', padding: '36px 10px', animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)' }}>
        <div style={{ width: 60, height: 60, borderRadius: 999, background: T.pineTint, margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Ion name="checkmark" size={30} color={T.pine} /></div>
        <div style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 23, color: T.ink, marginBottom: 6 }}>4,008 cards imported</div>
        <div style={{ fontFamily: T.sans, fontSize: 13.5, color: T.ink3, marginBottom: 24 }}>36 duplicates skipped · 142 ready to study now</div>
        <Btn full size="lg" icon="play" onClick={onStudy}>Study the new deck</Btn>
        <button onClick={onBack} style={{
          display: 'block', margin: '16px auto 0', background: 'none', border: 'none', cursor: 'pointer',
          fontFamily: T.sans, fontWeight: 700, fontSize: 14, color: T.ink2,
        }}>Done</button>
      </div>}
    </div>
  </div>;
}

Object.assign(window, { ImportScreen });
