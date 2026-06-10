/* Maranki App Redesign v2 — tokens & primitives.
   The v2 vocabulary: ledger rows on paper (hairlines, not card-soup),
   white cards reserved for the flashcard + hero moments, oversized serif,
   tabular mono numerals, fine ink-line data viz. Everything reads CSS vars
   so the whole app re-themes by flipping data-theme on the wrapper. */

const v2v = n => `var(${n})`;
const T = {
  paper: v2v('--paper'), paperSunk: v2v('--paper-sunk'), surface: v2v('--surface'),
  card: v2v('--card'), cardHover: v2v('--card-hover'),
  ink: v2v('--ink'), ink2: v2v('--ink-2'), ink3: v2v('--ink-3'), inkOn: v2v('--ink-on-color'),
  hair: v2v('--hairline'), hairStrong: v2v('--hairline-strong'), hairSoft: v2v('--hairline-soft'),
  pine: v2v('--pine'), pineDeep: v2v('--pine-deep'), pineBright: v2v('--pine-bright'),
  pineTint: v2v('--pine-tint'), pineTint2: v2v('--pine-tint-2'),
  amber: v2v('--amber'), amberDeep: v2v('--amber-deep'), amberTint: v2v('--amber-tint'), honey: v2v('--honey'),
  success: v2v('--success'), successTint: v2v('--success-tint'),
  warning: v2v('--warning'), warningTint: v2v('--warning-tint'),
  danger: v2v('--danger'), dangerTint: v2v('--danger-tint'),
  info: v2v('--info'), infoTint: v2v('--info-tint'),
  rateAgain: v2v('--rate-again'), rateHard: v2v('--rate-hard'),
  rateGood: v2v('--rate-good'), rateEasy: v2v('--rate-easy'),
  serif: "'Newsreader', Georgia, serif",
  sans: "'Hanken Grotesk', -apple-system, system-ui, sans-serif",
  mono: "'Spline Sans Mono', ui-monospace, monospace",
  shCard: v2v('--shadow-card'), shSm: v2v('--shadow-sm'), shMd: v2v('--shadow-md'), shLg: v2v('--shadow-lg'),
  inverseSurface: v2v('--inverse-surface'), inverseText: v2v('--inverse-text'), inverseAccent: v2v('--inverse-accent'),
  tabbarBg: v2v('--tabbar-bg'), scrim: v2v('--scrim'),
};
const CEFR = {
  A1: [v2v('--cefr-a1'), v2v('--cefr-a1-tint')], A2: [v2v('--cefr-a2'), v2v('--cefr-a2-tint')],
  B1: [v2v('--cefr-b1'), v2v('--cefr-b1-tint')], B2: [v2v('--cefr-b2'), v2v('--cefr-b2-tint')],
  C1: [v2v('--cefr-c1'), v2v('--cefr-c1-tint')], C2: [v2v('--cefr-c2'), v2v('--cefr-c2-tint')],
};
const STATE = {
  new: [v2v('--state-new'), v2v('--state-new-tint')], learning: [v2v('--state-learning'), v2v('--state-learning-tint')],
  review: [v2v('--state-review'), v2v('--state-review-tint')], mastered: [v2v('--state-mastered'), v2v('--state-mastered-tint')],
  due: [v2v('--state-due'), v2v('--state-due-tint')],
};
const STATE_ICON = { new: 'sparkles', learning: 'school', review: 'repeat', mastered: 'checkmark-circle', due: 'time' };
const softTint = (token, pct = 12) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const TOPPAD = 54;   // clears the status bar
const TABH = 80;     // bottom tab bar height

function Ion({ name, size = 22, color = 'currentColor', style = {} }) {
  return <ion-icon name={name} style={{ fontSize: size, color, ...style }}></ion-icon>;
}

/* ——— buttons ——— */
function Btn({ kind = 'primary', icon, children, onClick, full, size = 'md', sub, style = {}, disabled }) {
  const pad = size === 'lg' ? '15px 26px' : size === 'sm' ? '8px 15px' : '12px 20px';
  const fs = size === 'lg' ? 16.5 : size === 'sm' ? 13.5 : 15;
  const kinds = {
    primary: { background: T.pine, color: T.inkOn, boxShadow: T.shSm },
    reward: { background: T.amber, color: '#fff', boxShadow: T.shSm },
    secondary: { background: T.card, color: T.ink, border: `1px solid ${T.hairStrong}` },
    ghost: { background: 'transparent', color: T.pine },
    quiet: { background: T.paperSunk, color: T.ink2 },
    danger: { background: T.dangerTint, color: T.danger },
    dangerSolid: { background: T.danger, color: '#fff' },
  };
  return (
    <button onClick={disabled ? undefined : onClick}
      onMouseDown={e => { if (!disabled) e.currentTarget.style.transform = 'scale(0.97)'; }}
      onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
      onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
      style={{
        display: full ? 'flex' : 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        fontFamily: T.sans, fontWeight: 700, fontSize: fs, border: 'none', cursor: disabled ? 'default' : 'pointer',
        borderRadius: 999, padding: pad, width: full ? '100%' : undefined, opacity: disabled ? 0.45 : 1,
        boxSizing: 'border-box', transition: 'transform .14s, background .14s, opacity .2s', whiteSpace: 'nowrap',
        ...kinds[kind], ...style,
      }}>
      {icon && <Ion name={icon} size={fs + 3} />}
      {sub ? <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2 }}>
        <span>{children}</span>
        <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.75 }}>{sub}</span>
      </span> : children}
    </button>
  );
}

function IconBtn({ icon, onClick, size = 38, iconSize, color = T.ink2, bg = 'transparent', border, disabled, style = {} }) {
  return <button onClick={disabled ? undefined : onClick} style={{
    width: size, height: size, borderRadius: 999, background: bg, display: 'flex', alignItems: 'center',
    justifyContent: 'center', border: border ? `1px solid ${T.hairStrong}` : 'none',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1, flex: 'none',
    transition: 'opacity .2s', ...style,
  }}><Ion name={icon} size={iconSize || size * 0.55} color={color} /></button>;
}

/* ——— badges & chips ——— */
function LevelBadge({ level, size = 11.5 }) {
  const [fg, bg] = CEFR[level] || CEFR.A1;
  return <span style={{
    fontFamily: T.sans, fontWeight: 800, fontSize: size, color: fg, background: bg,
    padding: '3px 8px', borderRadius: 999, letterSpacing: '0.01em', flex: 'none',
  }}>{level}</span>;
}

function StateDot({ state, size = 7 }) {
  const [fg] = STATE[state] || STATE.new;
  return <span title={state} style={{ width: size, height: size, borderRadius: 999, background: fg, display: 'inline-block', flex: 'none' }} />;
}

function StateBadge({ state, label, icon }) {
  const [fg, bg] = STATE[state] || STATE.new;
  return <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.sans, fontWeight: 700,
    fontSize: 12, color: fg, background: bg, padding: '4px 10px', borderRadius: 999, flex: 'none',
  }}>{icon !== false && <Ion name={icon || STATE_ICON[state]} size={13} />}{label}</span>;
}

function Chip({ active, icon, children, onClick, dismiss, onDismiss }) {
  return <button onClick={onClick} style={{
    display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.sans, fontWeight: 650,
    fontSize: 13.5, cursor: 'pointer', padding: '7px 13px', borderRadius: 999,
    border: `1px solid ${active ? T.pine : T.hairStrong}`,
    background: active ? T.pine : 'transparent', color: active ? '#fff' : T.ink2,
    transition: 'all .14s', whiteSpace: 'nowrap', flex: 'none',
  }}>{icon && <Ion name={icon} size={14} />}{children}
    {dismiss && <Ion name="close" size={13} style={{ marginLeft: 2 }} onClick={onDismiss} />}</button>;
}

function Pill({ children, fg = T.ink2, bg = T.paperSunk, mono, style = {} }) {
  return <span style={{
    fontFamily: mono ? T.mono : T.sans, fontWeight: mono ? 500 : 700, fontSize: 12, color: fg,
    background: bg, padding: '3px 9px', borderRadius: 999, fontFeatureSettings: "'tnum' 1", flex: 'none', whiteSpace: 'nowrap', ...style,
  }}>{children}</span>;
}

/* ——— layout & type ——— */
function Overline({ children, style = {} }) {
  return <div style={{
    fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.09em',
    textTransform: 'uppercase', color: T.ink3, whiteSpace: 'nowrap', ...style,
  }}>{children}</div>;
}

function SectionHead({ children, action, actionLabel, onAction, style = {} }) {
  return <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '26px 0 6px', ...style }}>
    <Overline>{children}</Overline>
    {actionLabel && <button onClick={onAction} style={{
      background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.sans,
      fontWeight: 700, fontSize: 13, color: T.pine, display: 'flex', alignItems: 'center', gap: 4,
    }}>{actionLabel}</button>}
    {action}
  </div>;
}

/* ledger row — the v2 list idiom: hairline-separated rows on paper */
function Row({ children, onClick, pad = '14px 0', last, style = {} }) {
  return <div onClick={onClick} style={{
    display: 'flex', alignItems: 'center', gap: 12, padding: pad,
    borderBottom: last ? 'none' : `1px solid ${T.hairSoft}`,
    cursor: onClick ? 'pointer' : 'default', ...style,
  }}>{children}</div>;
}

function Card({ children, style = {}, onClick, pad = 16 }) {
  return <div onClick={onClick} style={{
    background: T.card, border: `1px solid ${T.hair}`, borderRadius: 16,
    boxShadow: T.shSm, padding: pad, boxSizing: 'border-box',
    cursor: onClick ? 'pointer' : 'default', ...style,
  }}>{children}</div>;
}

/* ——— data viz: fine ink lines ——— */
function Bar({ value, color = T.pine, track = T.paperSunk, h = 4 }) {
  return <div style={{ height: h, background: track, borderRadius: 999, overflow: 'hidden' }}>
    <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: color, borderRadius: 999, transition: 'width .5s cubic-bezier(0.22,1,0.36,1)' }} />
  </div>;
}

function SegBar({ mastered = 0, learning = 0, neww = 0, total, h = 4 }) {
  const t = total || (mastered + learning + neww) || 1;
  const pct = n => (n / t) * 100;
  return <div style={{ display: 'flex', height: h, background: T.paperSunk, borderRadius: 999, overflow: 'hidden', gap: 1 }}>
    {mastered > 0 && <div style={{ width: `${pct(mastered)}%`, background: T.pine }} />}
    {learning > 0 && <div style={{ width: `${pct(learning)}%`, background: T.amber }} />}
    {neww > 0 && <div style={{ width: `${pct(neww)}%`, background: T.info, opacity: 0.55 }} />}
  </div>;
}

function Ring({ value, size = 64, stroke = 5, color = T.pine, track = T.paperSunk, children }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, value / 100))} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset .6s cubic-bezier(0.22,1,0.36,1)' }} />
    </svg>
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{children}</div>
  </div>;
}

/* ——— controls ——— */
function SegCtrl({ options, value, onChange, size = 'md' }) {
  return <div style={{ display: 'flex', background: T.paperSunk, borderRadius: 999, padding: 3 }}>
    {options.map(o => {
      const on = value === (o.id ?? o);
      return <button key={o.id ?? o} onClick={() => onChange(o.id ?? o)} style={{
        flex: 1, padding: size === 'sm' ? '6px 10px' : '8px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
        background: on ? T.card : 'transparent', boxShadow: on ? T.shSm : 'none',
        fontFamily: T.sans, fontWeight: 700, fontSize: size === 'sm' ? 12.5 : 13.5, color: on ? T.ink : T.ink3,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'all .18s',
      }}>{o.icon && <Ion name={o.icon} size={14} />}{o.label ?? o}</button>;
    })}
  </div>;
}

function Toggle({ on, onChange }) {
  return <button onClick={() => onChange(!on)} style={{
    width: 46, height: 28, borderRadius: 999, border: 'none', cursor: 'pointer', flex: 'none',
    background: on ? T.pine : T.hairStrong, position: 'relative', transition: 'background .2s',
  }}>
    <span style={{
      position: 'absolute', top: 3, left: on ? 21 : 3, width: 22, height: 22, borderRadius: 999,
      background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', transition: 'left .2s cubic-bezier(0.22,1,0.36,1)',
    }} />
  </button>;
}

function Stepper({ value, onChange, min = 0, max = 999, step = 1, fmt }) {
  const btn = (icon, d, dis) => <button onClick={() => !dis && onChange(value + d)} style={{
    width: 30, height: 30, borderRadius: 999, border: `1px solid ${T.hairStrong}`, background: T.card,
    cursor: dis ? 'default' : 'pointer', opacity: dis ? 0.35 : 1, display: 'flex',
    alignItems: 'center', justifyContent: 'center', flex: 'none',
  }}><Ion name={icon} size={15} color={T.ink2} /></button>;
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    {btn('remove', -step, value <= min)}
    <span style={{ fontFamily: T.mono, fontSize: 14.5, fontWeight: 500, color: T.ink, minWidth: 34, textAlign: 'center', fontFeatureSettings: "'tnum' 1" }}>
      {fmt ? fmt(value) : value}</span>
    {btn('add', step, value >= max)}
  </div>;
}

function Field({ label, value, onChange, placeholder, mono, multiline, autoFocus, hint }) {
  const Comp = multiline ? 'textarea' : 'input';
  return <div style={{ marginBottom: 16 }}>
    <Overline style={{ marginBottom: 7 }}>{label}</Overline>
    <Comp value={value} autoFocus={autoFocus} placeholder={placeholder}
      onChange={e => onChange(e.target.value)} rows={multiline ? 2 : undefined}
      style={{
        width: '100%', boxSizing: 'border-box', background: T.card, border: `1px solid ${T.hairStrong}`,
        borderRadius: 12, padding: '12px 14px', fontFamily: mono ? T.mono : T.sans, fontSize: 15.5,
        color: T.ink, resize: 'none', lineHeight: 1.45,
      }} />
    {hint && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.ink3, marginTop: 5 }}>{hint}</div>}
  </div>;
}

/* ——— habit ——— */
function StreakChip({ days, freezes = 0, onClick }) {
  return <button onClick={onClick} style={{
    display: 'inline-flex', alignItems: 'center', gap: 6, background: T.amberTint, border: 'none',
    padding: '7px 12px 7px 10px', borderRadius: 999, cursor: 'pointer', flex: 'none',
  }}>
    <Ion name="flame" size={17} color={T.amber} />
    <span style={{ fontFamily: T.sans, fontWeight: 800, fontSize: 14.5, color: T.amberDeep, fontFeatureSettings: "'tnum' 1" }}>{days}</span>
    {freezes > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 2 }}>
      <Ion name="snow" size={13} color={T.info} />
      <span style={{ fontFamily: T.sans, fontWeight: 700, fontSize: 12, color: T.info }}>{freezes}</span>
    </span>}
  </button>;
}

/* ——— shell ——— */
function TabBar({ active, onChange, studyDue = 0 }) {
  const tabs = [
    { id: 'home', icon: 'home', label: 'Home' },
    { id: 'study', icon: 'book', label: 'Study', badge: studyDue },
    { id: 'browse', icon: 'search', label: 'Library' },
    { id: 'stats', icon: 'bar-chart', label: 'Progress' },
    { id: 'settings', icon: 'settings', label: 'Settings' },
  ];
  return <div style={{
    position: 'absolute', bottom: 0, left: 0, right: 0, height: TABH,
    background: T.tabbarBg, backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    borderTop: `1px solid ${T.hair}`, display: 'flex', alignItems: 'flex-start',
    paddingTop: 9, zIndex: 40,
  }}>
    {tabs.map(t => {
      const on = active === t.id;
      return <button key={t.id} onClick={() => onChange(t.id)} style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
        background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
      }}>
        <div style={{ position: 'relative' }}>
          <Ion name={on ? t.icon : `${t.icon}-outline`} size={23} color={on ? T.pine : T.ink3} />
          {t.badge > 0 && <span style={{
            position: 'absolute', top: -4, right: -11, minWidth: 16, height: 16, padding: '0 4px',
            boxSizing: 'border-box', background: T.danger, color: '#fff', borderRadius: 999,
            fontFamily: T.sans, fontWeight: 800, fontSize: 10, display: 'flex', alignItems: 'center',
            justifyContent: 'center', border: `1.5px solid ${T.surface}`,
          }}>{t.badge > 99 ? '99+' : t.badge}</span>}
        </div>
        <span style={{ fontFamily: T.sans, fontSize: 10.5, fontWeight: on ? 750 : 500, color: on ? T.pine : T.ink3 }}>{t.label}</span>
      </button>;
    })}
  </div>;
}

function Snackbar({ text, onUndo, actionLabel = 'Undo' }) {
  return <div style={{
    position: 'absolute', left: 16, right: 16, bottom: TABH + 12, zIndex: 70,
    background: T.inverseSurface, color: T.inverseText, borderRadius: 12, padding: '12px 14px 12px 16px',
    display: 'flex', alignItems: 'center', gap: 12, boxShadow: T.shLg,
    fontFamily: T.sans, fontSize: 13.5, animation: 'snackIn .24s cubic-bezier(0.22,1,0.36,1)',
  }}>
    <span style={{ flex: 1 }}>{text}</span>
    {onUndo && <button onClick={onUndo} style={{
      background: 'none', border: 'none', color: T.inverseAccent, fontFamily: T.sans, fontWeight: 800,
      fontSize: 13.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, flex: 'none',
    }}><Ion name="arrow-undo" size={14} />{actionLabel}</button>}
  </div>;
}

function Sheet({ open, onClose, children, title, maxH = '78%' }) {
  if (!open) return null;
  return <div style={{ position: 'absolute', inset: 0, zIndex: 60 }}>
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: T.scrim, animation: 'fadeIn .2s' }} />
    <div className="mk-scroll" style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, background: T.surface,
      borderRadius: '24px 24px 0 0', padding: '10px 20px 34px', boxShadow: T.shLg,
      animation: 'sheetUp .28s cubic-bezier(0.22,1,0.36,1)', maxHeight: maxH, overflowY: 'auto', boxSizing: 'border-box',
    }}>
      <div style={{ width: 36, height: 4, background: T.hairStrong, borderRadius: 999, margin: '0 auto 14px' }} />
      {title && <div style={{ fontFamily: T.serif, fontSize: 22, fontWeight: 600, color: T.ink, marginBottom: 12 }}>{title}</div>}
      {children}
    </div>
  </div>;
}

/* full-screen stack header (editors, import, session) */
function StackBar({ title, onBack, backIcon = 'chevron-back', right, sub }) {
  return <div style={{
    display: 'flex', alignItems: 'center', gap: 8, padding: `${TOPPAD}px 14px 10px`,
    borderBottom: `1px solid ${T.hairSoft}`,
  }}>
    <IconBtn icon={backIcon} onClick={onBack} size={36} iconSize={21} color={T.ink} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: T.sans, fontWeight: 750, fontSize: 16.5, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
      {sub && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.ink3 }}>{sub}</div>}
    </div>
    {right}
  </div>;
}

/* screen header (tabs): overline date/context + big serif title + actions */
function ScreenHead({ overline, title, sub, right, style = {} }) {
  return <div style={{ padding: `${TOPPAD + 6}px 0 4px`, ...style }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        {overline && <Overline style={{ marginBottom: 6 }}>{overline}</Overline>}
        <h1 style={{ margin: 0, fontFamily: T.serif, fontWeight: 600, fontSize: 32, lineHeight: 1.1, letterSpacing: '-0.02em', color: T.ink }}>{title}</h1>
        {sub && <div style={{ fontFamily: T.sans, fontSize: 14.5, color: T.ink2, marginTop: 6, whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
      {right && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none', paddingTop: 2 }}>{right}</div>}
    </div>
  </div>;
}

/* scrolling page body inside the device */
function Page({ children, pad = 20, bottom = TABH + 24, style = {} }) {
  return <div className="mk-scroll" style={{
    position: 'absolute', inset: 0, overflowY: 'auto', padding: `0 ${pad}px ${bottom}px`,
    boxSizing: 'border-box', background: T.paper, ...style,
  }}>{children}</div>;
}

function FAB({ onClick, icon = 'add' }) {
  return <button onClick={onClick} style={{
    position: 'absolute', right: 18, bottom: TABH + 18, width: 54, height: 54, borderRadius: 999,
    background: T.pine, border: 'none', boxShadow: T.shMd, cursor: 'pointer', zIndex: 45,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }}><Ion name={icon} size={26} color="#fff" /></button>;
}

/* settings-style list row */
function ListRow({ icon, iconColor = T.pine, iconBg = T.pineTint, title, sub, right, onClick, last, danger }) {
  return <Row onClick={onClick} last={last} pad="13px 0">
    {icon && <div style={{
      width: 34, height: 34, borderRadius: 10, background: danger ? T.dangerTint : iconBg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
    }}><Ion name={icon} size={17} color={danger ? T.danger : iconColor} /></div>}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: T.sans, fontWeight: 650, fontSize: 15, color: danger ? T.danger : T.ink }}>{title}</div>
      {sub && <div style={{ fontFamily: T.sans, fontSize: 12.5, color: T.ink3, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
    {right ?? <Ion name="chevron-forward" size={16} color={T.ink3} />}
  </Row>;
}

/* deck identity square (flag) */
function FlagSq({ flag, size = 38 }) {
  return <div style={{
    width: size, height: size, borderRadius: 10, background: T.paperSunk, border: `1px solid ${T.hairSoft}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, flex: 'none',
  }}>{flag}</div>;
}

Object.assign(window, {
  T, CEFR, STATE, STATE_ICON, TOPPAD, TABH, softTint, Ion, Btn, IconBtn, LevelBadge, StateDot,
  StateBadge, Chip, Pill, Overline, SectionHead, Row, Card, Bar, SegBar, Ring, SegCtrl, Toggle,
  Stepper, Field, StreakChip, TabBar, Snackbar, Sheet, StackBar, ScreenHead, Page, FAB, ListRow, FlagSq,
});
