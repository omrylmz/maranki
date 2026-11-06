/**
 * "Your decks" on Today (spec §8.1, unit W4-1).
 *
 *   YOUR DECKS
 *   🇩🇪 German                      22 due · 10 new      [Study 30]
 *   🧩 Algo Deck     All caught up ✓          ›
 *   ⏸ Paused (1)                                             ›
 *   Each Study button is a session of that deck only. …     ← only when the pills add up to more than the total;
 *                                                              then it names the real cause (todayLogic sharedLimitNote)
 *
 * - Row tap → the deck page (`/deck/[id]`, the hub). The "Study {n}" pill →
 *   a session of that deck. The pill's number is the deck's own session
 *   (DeckSummary.ready = readyFor({ decks: [id] })), so it is exactly the
 *   number of cards that session shows.
 * - The line under the name says what is in that deck's session
 *   ("{d} due · {n} new") — never "ready", because the daily new-card limit is
 *   shared: two decks can each show "10 new" while the total brings 10 new in
 *   all (device finding 2026-10-24). The note under the rows says it in words,
 *   and only the causes that are true (new-card limit, review limit, session size).
 * - Paused decks collapse into "Paused ({n})"; a tap opens them. A paused
 *   deck has no pill: its cards leave Today. Its deck page still studies it.
 *
 * Every number comes from useDeckStatsMap(): ONE pass over all cards for
 * every deck (spec §8.1), not one count per row.
 *
 * Large font sizes (device pass 2026-11-02, F1-2): a deck name WRAPS (up to
 * todayNameLines lines), so "German — Everyday" and "German — Conversation"
 * never both read "German — E…". At a large font size (useLargeText) the
 * "Study {n}" pill moves under the name, so the name has the whole width.
 */
import { type Href, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { A11Y_HIDDEN, Btn, DeckTile, Ion, Row, SectionHead } from '@/components/ui';
import { useLargeText } from '@/components/ui/layout';
import type { Deck, Id, ReadyCounts } from '@/domain/model';
import type { DeckSummary } from '@/domain/scope';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  deckRoute,
  deckRowModel,
  deckScope,
  pausedLabel,
  sessionRoute,
  sharedLimitNote,
  studyLabel,
} from './todayLogic';

interface DeckRowsProps {
  active: readonly Deck[];
  paused: readonly Deck[];
  stats: ReadonlyMap<Id, DeckSummary>;
  /** The hero's counts (readyFor({})), for the shared-limit note. */
  hero: ReadyCounts;
  showPaused: boolean;
  onTogglePaused: () => void;
}

export function DeckRows({ active, paused, stats, hero, showPaused, onTogglePaused }: DeckRowsProps) {
  const c = useColors();
  const router = useRouter();
  if (active.length === 0 && paused.length === 0) return null;

  const models = active.map((d) => deckRowModel(stats.get(d.id), false));
  // The pills' own counts (a pill is the deck's `ready`; a row without a pill counts 0).
  const note = sharedLimitNote(
    active.flatMap((d, i) => {
      const ready = stats.get(d.id)?.ready;
      return models[i].pill !== null && ready ? [ready] : [];
    }),
    hero,
  );

  const openDeck = (deck: Deck) => {
    // Deck page route (unit W4-3).
    router.push(deckRoute(deck.id) as Href);
  };
  const study = (deck: Deck) => {
    router.push(sessionRoute('scheduled', deckScope(deck.id), deck.name) as unknown as Href);
  };

  return (
    <View>
      <SectionHead>Your decks</SectionHead>
      {active.map((deck, i) => {
        const model = models[i];
        return (
          <DeckRow
            key={deck.id}
            deck={deck}
            line={model.line}
            pill={model.pill}
            onOpen={() => openDeck(deck)}
            onStudy={() => study(deck)}
            last={i === active.length - 1 && paused.length === 0}
          />
        );
      })}

      {paused.length > 0 && (
        <Row
          onPress={onTogglePaused}
          padV={13}
          last={!showPaused}
          label={`${pausedLabel(paused.length)}, ${showPaused ? 'shown' : 'hidden'}`}
          hint={showPaused ? 'Hides the paused decks' : 'Shows the paused decks'}
        >
          <View {...A11Y_HIDDEN}>
            <Ion name="pause-circle-outline" size={20} color={c.ink3} />
          </View>
          <Text style={[font('sans', 700), tnum, { flex: 1, fontSize: 14.5, color: c.ink2 }]}>
            {pausedLabel(paused.length)}
          </Text>
          <View {...A11Y_HIDDEN}>
            <Ion name={showPaused ? 'chevron-down' : 'chevron-forward'} size={16} color={c.ink3} />
          </View>
        </Row>
      )}
      {showPaused &&
        paused.map((deck, i) => (
          <DeckRow
            key={deck.id}
            deck={deck}
            line={deckRowModel(stats.get(deck.id), true).line}
            pill={null}
            onOpen={() => openDeck(deck)}
            onStudy={() => study(deck)}
            last={i === paused.length - 1}
            dim
          />
        ))}

      {note && (
        <View style={{ flexDirection: 'row', gap: 6, paddingTop: 10 }}>
          <View {...A11Y_HIDDEN}>
            <Ion name="information-circle-outline" size={14} color={c.ink3} style={{ marginTop: 2 }} />
          </View>
          <Text style={[font('sans', 400), { flex: 1, fontSize: 12.5, lineHeight: 18, color: c.ink3 }]}>
            {note}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * How many lines a deck or list name may take on Today (DeckRows, ListRows):
 * 2 at the normal font size (the pill is next to it), 3 at a large one (the
 * pill is under it, so the name has the whole row). Only a very long name is
 * still cut, and then at its END: the start and the middle, which tell two
 * decks apart, are shown.
 *
 *   todayNameLines(false) → 2
 *   todayNameLines(true)  → 3
 */
export function todayNameLines(large: boolean): number {
  return large ? 3 : 2;
}

/** The size of the deck icon on a Today row; at a large font size the pill is indented by it (+ the gap). */
const TILE = 38;
const TILE_GAP = 12;

/**
 * One deck row. The row (icon, name, line) and the pill are TWO touch
 * targets side by side, not a button inside a button: a screen reader can
 * then reach both ("German, 22 due · 10 new" and "Study 30 from German").
 *
 *   normal font size:   [🇩🇪  German — Conversation   ] [Study 21]
 *                            21 new
 *   large font size:    [🇩🇪  German —                 ]
 *                            Conversation
 *                            21 new
 *                            [Study 21]
 */
function DeckRow({
  deck,
  line,
  pill,
  onOpen,
  onStudy,
  last,
  dim,
}: {
  deck: Deck;
  line: string;
  pill: number | null;
  onOpen: () => void;
  onStudy: () => void;
  last: boolean;
  dim?: boolean;
}) {
  const c = useColors();
  const large = useLargeText();
  return (
    <View
      style={{
        // Large font size: the pill goes under the name (see above).
        flexDirection: large ? 'column' : 'row',
        alignItems: large ? 'stretch' : 'center',
        gap: large ? 0 : 10,
        paddingBottom: large && pill !== null ? 14 : 0,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.hairlineSoft,
        opacity: dim ? 0.75 : 1,
      }}
    >
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${deck.name}, ${line}`}
        accessibilityHint="Opens the deck page"
        style={({ pressed }) => ({
          flex: large ? undefined : 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: TILE_GAP,
          paddingVertical: 14,
          paddingBottom: large && pill !== null ? 10 : 14,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <DeckTile icon={deck.icon} source={deck.source} size={TILE} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* Wraps (F1-2): two decks that start the same never look the same. */}
          <Text numberOfLines={todayNameLines(large)} style={[font('sans', 700), { fontSize: 15.5, color: c.ink }]}>
            {deck.name}
          </Text>
          <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}>{line}</Text>
        </View>
        {pill === null && (
          <View {...A11Y_HIDDEN}>
            <Ion name="chevron-forward" size={16} color={c.ink3} />
          </View>
        )}
      </Pressable>
      {pill !== null && (
        <Btn
          size="sm"
          onPress={onStudy}
          label={`${studyLabel(pill)} from ${deck.name}`}
          // Under the name, in line with it (past the deck icon).
          style={large ? { marginLeft: TILE + TILE_GAP } : undefined}
        >
          {studyLabel(pill)}
        </Btn>
      )}
    </View>
  );
}
