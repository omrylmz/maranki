/**
 * CardSheet — everything about one card, and every real thing you can do
 * with it (spec §8.4; it replaces CardPeek, unit A1). Opened from a Library
 * row, Today's "Up first" (long press), and read-only from a session's
 * "Card info" (spec §6.5).
 *
 *   <CardSheet cardId={peekId} open={peekId !== null} onClose={() => setPeekId(null)} />
 *   <CardSheet cardId={card.id} open={info} onClose={…} readOnly hideAnswer={!revealed} />   // session "Card info"
 *
 *   die Reise                                         🔊
 *   the trip
 *   GRAMMAR       -n
 *   EXAMPLE       Die Reise war lang.
 *   LEVEL         B1
 *   ● Review · next in 4 days
 *   🗂 German › Vocabulary › B1
 *   (tag chips — tap = Library with that Tag chip)
 *   [ ♡ Favorite ] [ ⚑ Flag ] [ ⏸ Suspend ]       ← real toggles; labels show the current state
 *   STATUS   ( Not started ) ( In queue ) ( Known )
 *   Reset progress…                     Reschedule…
 *   History: 7 reviews · 1 lapse · last: 3 days ago (Good)
 *   [ ✎ Edit card ]
 *   Practice this card · Move to deck… · Delete card…
 *
 * How it works:
 *   - The card, its note, card type and deck are read LIVE from the store
 *     (useStateV3), so a toggle shows its new state at once and the sheet
 *     stays open. The text comes from the face (useFaces(), spec §6.2).
 *   - Every change goes through a v3 store command (setFlags, learn,
 *     markKnown, setNotStarted, resetProgress, reschedule, moveNotes) and
 *     shows a snackbar with Undo (`undoManualEdit`). "Delete card…" uses
 *     deleteNotes, and its Undo is `undoDelete`. A sheet is a native modal
 *     that covers the screen's snackbar, so the sheet shows the same
 *     snackbar itself. It is pinned to the TOP of the sheet's PANEL
 *     (Sheet `overlay`), not put in the scrolling content: a long card
 *     (an image, many rows) would push it below the visible part, and the
 *     Undo would be lost. Why the top and not the bottom: the last rows of
 *     the sheet are "Move to deck…" and "Delete card…". A bar at the bottom
 *     covered "Delete card…", so a late tap on Undo (just after the bar
 *     went away) opened "Delete this card?" (walkthrough M5). At the top it
 *     sits over the card's text, which does nothing on a tap. An Undo bar
 *     stays at least 5 s (SnackbarContext). It shows only messages that
 *     came while the sheet is open (an older Library message is not about
 *     this card).
 *   - The History line reads the card's rows from the review history
 *     (revlog, src/store/history.ts) after the sheet opens.
 *   - The smaller sheets (Reschedule, Move to deck, the two confirmations)
 *     open ON TOP of this one (a modal inside a modal), so closing them
 *     comes back here.
 *   - The card is kept while the sheet slides out, also when the caller
 *     sets `cardId` to null or the card was just deleted (L22).
 *   - A tap on a picture of the card shows it full screen (the shared
 *     ImageViewer of the study card, src/components/ui/ImageViewer.tsx,
 *     wave 5i): the same opaque backdrop, the light image well behind the
 *     picture, "Close image", and Android's Back closes the picture first
 *     (it is a modal on top of this sheet). Before, a tap on a picture here
 *     did nothing, while the same picture opened full screen in a session.
 *   - A session's "Card info" while the card on screen is NOT revealed yet
 *     (`hideAnswer`, wave 5h): the question only, and "The answer shows
 *     after you reveal the card." in place of the answer. The status, the
 *     details and the History stay. Before, it showed the answer: a
 *     spoiler (device pass E7). Outside a session the sheet never hides it.
 *
 * Every rule (labels, which rows show, what a tap does, the History lapse
 * count) is in cardSheetLogic.ts (pure, tested). This file holds React
 * state and layout only.
 */
import { Image } from 'expo-image';
import { type Href, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, type TextStyle, useWindowDimensions, View } from 'react-native';

import { DeckPickerSheet } from '@/components/editor/DeckPickerSheet';
import { RescheduleSheet } from '@/components/study/RescheduleSheet';
import { isUndoableEdit, NOTHING_TO_RESCHEDULE, undoManualEditAndReport } from '@/components/study/rescheduleLogic';
import { PICTURE_LABEL } from '@/components/study/sessionLogic';
import {
  A11Y_HIDDEN,
  Btn,
  Chip,
  FieldRows,
  IconBtn,
  Ion,
  ListRow,
  Overline,
  Pill,
  SegCtrl,
  Sheet,
  SnackbarView,
  StateDot,
  type RenderImage,
} from '@/components/ui';
import { LABEL_FONT_CAP, labelColumnWidth } from '@/components/ui/FieldRows';
import { ImageViewer, OPEN_IMAGE_HINT } from '@/components/ui/ImageViewer';
import type { SpokenText } from '@/domain/face';
import type { DataStateV3, FieldBlock, Id, RevlogRow } from '@/domain/model';
import { speak } from '@/domain/speech';
import { mediaFileUri } from '@/platform/media';
import { useData } from '@/store/DataContext';
import { useFaces } from '@/store/faces';
import { putSelection } from '@/store/selectionRegistry';
import { useEngine, useSessionLength, useStateV3 } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { appRevlogStore } from '@/store/storage';
import { useNow } from '@/store/useNow';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  blockImages,
  CARD_SHEET_COPY,
  cardLabel,
  cardSheetSections,
  cardSheetSourceReader,
  cardStatus,
  deckPath,
  deleteConfirmBody,
  deleteRowSub,
  deleteSnack,
  editCardRoute,
  flagPatch,
  flagSnack,
  flagToggles,
  headlineText,
  historyLapsesOf,
  historyLineOf,
  type InfoRow,
  infoRows,
  isStatusSegment,
  libraryTagHref,
  moveSnack,
  practiceRoute,
  RESET_SNACK,
  SHEET_SNACK_TOP,
  sheetFace,
  type SheetFlag,
  statusChange,
  statusSegmentOf,
  statusSegments,
  tagChipLabel,
  visibleTags,
} from './cardSheetLogic';

interface CardSheetProps {
  /** The card to show; null = none. The sheet keeps the last card while it slides out. */
  cardId: string | null;
  open: boolean;
  onClose: () => void;
  /** The session's "Card info": shows the card and its details, changes nothing. */
  readOnly?: boolean;
  /**
   * The session's "Card info" while the card on screen is not revealed yet:
   * show the question only, never the answer (sheetFace, wave 5h).
   */
  hideAnswer?: boolean;
  /**
   * With `hideAnswer`: the question as the session asks it, when that is not
   * the face's question (Articles: the bare word, "Zauberer"; its article is
   * the answer). The sheet shows and speaks this instead.
   */
  question?: SpokenText;
}

/** The smaller sheet open on top of this one. */
type Panel = 'reschedule' | 'move' | 'reset' | 'delete';

/* Stable selectors (module level, so the store hook keeps them). */
const decksOf = (s: DataStateV3) => s.decks;
const readAloudOf = (s: DataStateV3) => s.settings?.readAloudEnabled === true;

/**
 * `speak` with the language of the text. From W4-4 speech.ts passes it to
 * the voice (spec §6.8); a one-argument `speak` simply ignores it, so this
 * call is right before and after that change.
 */
const say: (text: string, lang?: string) => void = speak;

/** A new Library `nonce` (event handlers only: it reads the clock). */
function freshNonce(): string {
  return String(Date.now());
}

export function CardSheet({ cardId, open, onClose, readOnly = false, hideAnswer = false, question }: CardSheetProps) {
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const engine = useEngine();
  const { actions } = useData();
  const { show } = useSnackbar();
  const faceOf = useFaces();

  // Keep the last card through the slide-out (adjust-state-during-render).
  const [shownId, setShownId] = useState<Id | null>(cardId);
  if (cardId && cardId !== shownId) setShownId(cardId);

  const reader = useMemo(() => cardSheetSourceReader(shownId), [shownId]);
  const live = useStateV3(reader);
  const decks = useStateV3(decksOf);
  const readAloud = useStateV3(readAloudOf);
  const practiceCount = useSessionLength({ kind: 'practice', sel: shownId ? [shownId] : [] });

  // The live card with its face; a deleted card keeps its last view while the sheet closes.
  const liveView = useMemo(() => (live ? { source: live, face: faceOf(live.card) } : null), [live, faceOf]);
  const [kept, setKept] = useState(liveView);
  if (liveView && liveView !== kept) setKept(liveView);
  const view = liveView ?? (kept && kept.source.card.id === shownId ? kept : null);

  const [panel, setPanel] = useState<Panel | null>(null);
  // The picture shown full screen (its file address), or null.
  const [viewer, setViewer] = useState<string | null>(null);

  /* ------------------------------------------------------- History (revlog) */

  // Read again when the card was studied (reps / lastReviewedAt change).
  const historyCardId = open && view ? view.source.card.id : null;
  const historyKey =
    historyCardId && view ? `${historyCardId}|${view.source.card.reps}|${view.source.card.lastReviewedAt ?? ''}` : null;
  const [history, setHistory] = useState<{ key: string; rows: RevlogRow[] | null } | null>(null);
  useEffect(() => {
    if (historyKey === null || historyCardId === null) return;
    let current = true;
    appRevlogStore()
      .forCard(historyCardId)
      .then(
        (rows) => {
          if (current) setHistory({ key: historyKey, rows });
        },
        // The history could not be read: the sheet shows no History line.
        () => {
          if (current) setHistory({ key: historyKey, rows: null });
        },
      );
    return () => {
      current = false;
    };
  }, [historyKey, historyCardId]);
  const historyRows = history && history.key === historyKey ? history.rows : null;

  const onClosed = () => {
    setShownId(null);
    setKept(null);
    setPanel(null);
    setHistory(null);
    setViewer(null);
  };

  /* ------------------------------------------------------- nothing to show */

  if (!view) {
    return (
      <Sheet open={open} onClose={onClose} onClosed={onClosed}>
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          {CARD_SHEET_COPY.missing}
        </Text>
        <Btn kind="secondary" full onPress={onClose}>
          Close
        </Btn>
      </Sheet>
    );
  }

  const { source, face } = view;
  const { card, note, deck, siblings } = source;
  // The whole card, or (a session's "Card info" before the reveal) the question only.
  const shown = sheetFace(face, { hideAnswer, question });
  const { layout, headline, spoken } = shown;
  const status = cardStatus(card, deck, now);
  const sections = cardSheetSections(card, { readOnly, practiceCount });
  const tags = visibleTags(note?.tags);
  const label = cardLabel(face);
  // null = no History line (the history could not be read, or it has no rows for a studied card).
  const historyLine = historyRows ? historyLineOf(historyRows, card, now) : null;
  // The lapses of that History line: the read-only "Lapses" row explains when its own number differs.
  const historyLapses = historyLapsesOf(historyRows);

  /* ------------------------------------------------------------ handlers */

  /** A follow-up message after Undo waits one tick: the snackbar host clears the bar right after the Undo handler. */
  const later = (message: string) => setTimeout(() => show(message), 0);

  /** The snackbar of a manual edit, with Undo. Nothing changed (no edit kept) → no snackbar. */
  const offerUndo = (text: string, editId: string) => {
    if (!isUndoableEdit(engine.store.getState().manualLog, editId)) return;
    show(text, { onAction: () => undoManualEditAndReport(actions.undoManualEdit, editId, later) });
  };

  const toggle = (key: SheetFlag) => {
    const patch = flagPatch(card, key);
    const editId = actions.setFlags([card.id], patch);
    offerUndo(flagSnack(key, patch[key] === true), editId);
  };

  const setStatus = (id: string) => {
    const change = isStatusSegment(id) ? statusChange(card, id) : null;
    if (!change) return;
    const editId =
      change.command === 'learn'
        ? actions.learn([card.id])
        : change.command === 'markKnown'
          ? actions.markKnown([card.id])
          : actions.setNotStarted([card.id]);
    offerUndo(change.snack, editId);
  };

  const confirmReset = () => {
    setPanel(null);
    offerUndo(RESET_SNACK, actions.resetProgress([card.id]));
  };

  const moveTo = (deckId: Id) => {
    if (deckId === card.deckId) return;
    const target = decks.find((d) => d.id === deckId);
    // Moves the whole note: every direction stays in one deck.
    const editId = actions.moveNotes([card.noteId], deckId);
    offerUndo(moveSnack(target?.name ?? 'another deck', siblings), editId);
  };

  const confirmDelete = () => {
    setPanel(null);
    // Deletes the note, so every direction of it (the sheet said so).
    const token = actions.deleteNotes([card.noteId]);
    onClose();
    show(deleteSnack(label), { onAction: () => actions.undoDelete(token) });
  };

  const editCard = () => {
    onClose();
    router.push(editCardRoute(card.noteId));
  };

  const practice = () => {
    // Card ids never go into a URL: the session reads them by this token.
    const token = putSelection([card.id]);
    onClose();
    router.push(practiceRoute(token, label));
  };

  const openTag = (tag: string) => {
    onClose();
    // The Library route comes with wave 4b, so typed routes do not know it yet.
    router.push(libraryTagHref(tag, freshNonce()) as Href);
  };

  const renderImage: RenderImage = (src, key) => <CardImage key={key} deckId={card.deckId} name={src} onOpen={setViewer} />;
  const toggles = flagToggles(card);
  const muted: TextStyle[] = [font('sans', 400), { fontSize: 13.5, lineHeight: 19, color: c.ink2 }];

  return (
    // The snackbar is pinned to the top of the panel (outside the scroll), so its Undo is always
    // in view and never covers "Delete card…" at the bottom.
    <Sheet open={open} onClose={onClose} onClosed={onClosed} overlay={sections.edit ? <SheetSnack /> : null}>
      {/* the face: headline (+ read aloud), subline, labelled rows */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <Text
          accessibilityRole="header"
          style={[
            font('serif', 600),
            { flex: 1, fontSize: 28, lineHeight: 33, letterSpacing: -0.42, color: c.ink },
          ]}
        >
          {headline || '—'}
        </Text>
        {readAloud && spoken.text ? (
          <IconBtn
            icon="volume-high-outline"
            label={CARD_SHEET_COPY.speak}
            onPress={() => say(spoken.text, spoken.lang)}
          />
        ) : null}
      </View>
      <BlockImages block={layout.headline} renderImage={renderImage} />
      {layout.subline ? (
        <>
          <Text style={[font('sans', 700), { fontSize: 17, lineHeight: 23, color: c.ink, marginTop: 10 }]}>
            {headlineText(layout.subline)}
          </Text>
          <BlockImages block={layout.subline} renderImage={renderImage} />
        </>
      ) : null}
      <FieldRows blocks={layout.rows} renderImage={renderImage} style={{ marginTop: 10 }} />
      {shown.answerHidden ? (
        <Text style={[font('sans', 400, true), { fontSize: 13.5, lineHeight: 19, color: c.ink3, marginTop: 10 }]}>
          {CARD_SHEET_COPY.answerHidden}
        </Text>
      ) : null}

      {/* status, deck › section, tags */}
      <View style={{ marginTop: 14, gap: 6 }}>
        <View
          accessible
          accessibilityLabel={`Status: ${status.text}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
        >
          <StateDot state={status.key} size={8} />
          <Text style={[...muted, { flex: 1 }]}>{status.text}</Text>
        </View>
        <Text style={muted} numberOfLines={2}>
          {deck ? `${deck.icon} ` : ''}
          {deckPath(deck, note?.section)}
        </Text>
      </View>
      {tags.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {tags.map((tag) =>
            sections.tagsTappable ? (
              <Chip key={tag} icon="pricetag-outline" label={`Tag: ${tagChipLabel(tag)}`} onPress={() => openTag(tag)}>
                {tagChipLabel(tag)}
              </Chip>
            ) : (
              <Pill key={tag}>{tagChipLabel(tag)}</Pill>
            ),
          )}
        </View>
      ) : null}

      {sections.edit ? (
        <>
          {/* the real toggles (spec §7 #19, #20): the label is the action, the look is the state */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 18 }}>
            {toggles.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => toggle(t.key)}
                accessibilityRole="switch"
                accessibilityLabel={t.name}
                accessibilityState={{ checked: t.on }}
                style={({ pressed }) => ({
                  flex: 1,
                  alignItems: 'center',
                  gap: 4,
                  minHeight: 56,
                  justifyContent: 'center',
                  backgroundColor: t.on ? c.pineTint : c.paperSunk,
                  borderWidth: 1,
                  borderColor: t.on ? c.pine : 'transparent',
                  borderRadius: 12,
                  paddingVertical: 10,
                  transform: [{ scale: pressed ? 0.96 : 1 }],
                })}
              >
                <View {...A11Y_HIDDEN}>
                  <Ion name={t.icon} size={18} color={t.on ? c.pine : c.ink2} />
                </View>
                <Text style={[font('sans', 700), { fontSize: 12, color: t.on ? c.pine : c.ink2 }]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          {/* Status (spec §8.4): Not started only for a card that was never studied */}
          <View style={{ marginTop: 16, gap: 8 }}>
            <Overline>{CARD_SHEET_COPY.status}</Overline>
            <SegCtrl
              size="sm"
              label={CARD_SHEET_COPY.status}
              options={statusSegments(card)}
              value={statusSegmentOf(card)}
              onChange={setStatus}
            />
          </View>

          {/* Reset progress… · Reschedule… */}
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginTop: 12,
            }}
          >
            {sections.reset ? (
              <Btn kind="ghost" size="sm" icon="refresh-outline" onPress={() => setPanel('reset')}>
                {CARD_SHEET_COPY.reset}
              </Btn>
            ) : (
              <View />
            )}
            {sections.reschedule === 'offer' ? (
              <Btn kind="ghost" size="sm" icon="calendar-outline" onPress={() => setPanel('reschedule')}>
                {CARD_SHEET_COPY.reschedule}
              </Btn>
            ) : (
              <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>{NOTHING_TO_RESCHEDULE}</Text>
            )}
          </View>
        </>
      ) : null}

      {sections.info ? <InfoRows rows={infoRows(source, historyLapses)} /> : null}

      {historyLine ? (
        <Text style={[font('sans', 400), { fontSize: 13, lineHeight: 18, color: c.ink3, marginTop: 14 }]}>
          {historyLine}
        </Text>
      ) : null}

      {sections.edit ? (
        <>
          <Btn full kind="secondary" icon="pencil" onPress={editCard} style={{ marginTop: 16 }}>
            {CARD_SHEET_COPY.edit}
          </Btn>
          <View style={{ marginTop: 8 }}>
            {sections.practice ? (
              <ListRow
                icon="barbell-outline"
                title={CARD_SHEET_COPY.practice}
                sub={CARD_SHEET_COPY.practiceSub}
                onPress={practice}
              />
            ) : null}
            <ListRow
              icon="swap-horizontal-outline"
              title={CARD_SHEET_COPY.move}
              sub={deck ? `Now in ${deck.name}` : undefined}
              onPress={() => setPanel('move')}
            />
            <ListRow
              icon="trash-outline"
              danger
              title={CARD_SHEET_COPY.delete}
              sub={deleteRowSub(siblings)}
              onPress={() => setPanel('delete')}
              last
            />
          </View>

          {/* the smaller sheets, on top of this one */}
          <RescheduleSheet cardIds={[card.id]} open={open && panel === 'reschedule'} onClose={() => setPanel(null)} />
          <DeckPickerSheet
            open={open && panel === 'move'}
            onClose={() => setPanel(null)}
            decks={decks}
            selectedId={card.deckId}
            onPick={moveTo}
            title={CARD_SHEET_COPY.moveTitle}
          />
          <Sheet open={open && panel === 'reset'} onClose={() => setPanel(null)} title={CARD_SHEET_COPY.resetTitle}>
            <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
              {CARD_SHEET_COPY.resetBody}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setPanel(null)}>
                {CARD_SHEET_COPY.cancel}
              </Btn>
              <Btn kind="primary" full style={{ flex: 1 }} onPress={confirmReset}>
                {CARD_SHEET_COPY.resetConfirm}
              </Btn>
            </View>
          </Sheet>
          <Sheet open={open && panel === 'delete'} onClose={() => setPanel(null)} title={CARD_SHEET_COPY.deleteTitle}>
            <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
              {deleteConfirmBody(label, siblings)}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setPanel(null)}>
                {CARD_SHEET_COPY.cancel}
              </Btn>
              <Btn kind="dangerSolid" full style={{ flex: 1 }} onPress={confirmDelete}>
                {CARD_SHEET_COPY.deleteConfirm}
              </Btn>
            </View>
          </Sheet>
        </>
      ) : null}

      {/* a picture, full screen (a modal on top of this sheet; Back closes it first) */}
      <ImageViewer uri={open ? viewer : null} onClose={() => setViewer(null)} />
    </Sheet>
  );
}

/* ------------------------------------------------------------ small parts */

/**
 * The app's snackbar, drawn on the sheet's panel (the Sheet `overlay`, at
 * its TOP, over the card's text — never over the destructive rows at the
 * bottom). It shows the same message as the screen's SnackbarHost (one
 * global channel) and behaves the same way: the action runs, then the bar
 * closes.
 *
 * It mounts when the sheet opens. A message that was already there then
 * (for example a Library "Undo" for 12 cards) is not shown here: it is not
 * about this card. Every message shown after that is a new object, so it
 * shows.
 */
function SheetSnack() {
  const { snack, dismiss } = useSnackbar();
  const [before] = useState(snack);
  if (!snack || snack === before) return null;
  return (
    <SnackbarView
      text={snack.text}
      actionLabel={snack.actionLabel}
      onAction={
        snack.onAction
          ? () => {
              snack.onAction?.();
              dismiss();
            }
          : undefined
      }
      top={SHEET_SNACK_TOP}
    />
  );
}

/** The images of a headline or subline block (FieldRows draws the images of the other rows). */
function BlockImages({ block, renderImage }: { block: FieldBlock | null; renderImage: RenderImage }) {
  const names = blockImages(block);
  if (names.length === 0) return null;
  return <View style={{ marginTop: 8, gap: 8 }}>{names.map((name, i) => renderImage(name, `img:${i}`))}</View>;
}

/** The file:// address of a deck image, or null (unsafe name, file missing, or no file system). */
function imageUri(deckId: Id, name: string): string | null {
  try {
    return mediaFileUri(deckId, name);
  } catch {
    return null;
  }
}

/**
 * One imported image (spec §5.8), full width, at its own shape once it has
 * loaded. A missing file draws nothing (the field's text still shows).
 * It sits on the image well (`c.imageWell`), light in both themes, like on
 * the study card. WHY (wave 5g, Evening): many imported pictures are black
 * line art on a transparent background, and on the dark paperSunk well their
 * lines could not be seen.
 *
 * A tap shows it full screen (`onOpen` → the shared ImageViewer, wave 5i),
 * like a picture on the study card. For a screen reader it is a "Picture"
 * image button with the same hint as there.
 */
function CardImage({ deckId, name, onOpen }: { deckId: Id; name: string; onOpen: (uri: string) => void }) {
  const c = useColors();
  const uri = useMemo(() => imageUri(deckId, name), [deckId, name]);
  const [ratio, setRatio] = useState<number | null>(null);
  if (!uri) return null;
  return (
    <Pressable
      onPress={() => onOpen(uri)}
      accessibilityRole="imagebutton"
      accessibilityLabel={PICTURE_LABEL}
      accessibilityHint={OPEN_IMAGE_HINT}
      style={{ alignSelf: 'stretch', marginTop: 6 }}
    >
      <Image
        source={{ uri }}
        contentFit="contain"
        onLoad={(event) => {
          const { width, height } = event.source;
          if (width > 0 && height > 0) setRatio(width / height);
        }}
        style={{
          width: '100%',
          aspectRatio: ratio ?? 4 / 3,
          maxHeight: 260,
          borderRadius: 10,
          backgroundColor: c.imageWell,
        }}
      />
    </Pressable>
  );
}

/**
 * The read-only details: "CARD TYPE  German Verbs", one row each (a row's
 * note goes under its value).
 *
 * The label column is the SAME as the field rows above it (FieldRows
 * 'side'): `labelColumnWidth(fontScale)` wide, so the values of both lists
 * start at the same x, and the label WRAPS instead of being cut. Its text
 * grows with the system text size up to LABEL_FONT_CAP, where the column
 * stops growing too. WHY (wave 5c, review of L3): the label was a one-line
 * 96 pt Overline. At a larger text size "REPETITIONS" showed as
 * "REPETITI…", and the info values did not line up with the field values.
 */
function InfoRows({ rows }: { rows: InfoRow[] }) {
  const c = useColors();
  // The system text size: the label column grows with it, like the field rows (FieldRows).
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ marginTop: 16 }}>
      {rows.map((row, i) => (
        <View
          key={row.label}
          accessible
          accessibilityLabel={row.note ? `${row.label}: ${row.value}. ${row.note}` : `${row.label}: ${row.value}`}
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: 12,
            paddingVertical: 8,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: c.hairlineSoft,
          }}
        >
          {/* The field label look (FieldRows FieldLabel): Overline's font, but it wraps. */}
          <Text
            maxFontSizeMultiplier={LABEL_FONT_CAP}
            style={[
              font('sans', 700),
              {
                width: labelColumnWidth(fontScale),
                fontSize: 11,
                lineHeight: 15,
                letterSpacing: 11 * 0.09,
                textTransform: 'uppercase',
                color: c.ink3,
              },
            ]}
          >
            {row.label}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink }]}>{row.value}</Text>
            {row.note ? (
              <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 17, color: c.ink3, marginTop: 2 }]}>
                {row.note}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}
