/**
 * DeckSettings — the "DECK SETTINGS" rows of the deck page (spec §8.2, §9.3):
 *
 *   New cards per day         Use my daily limit (10)          → NewCardsSheet
 *   New card order            Deck order                       → NewCardsSheet
 *   New cards arrive as       In my queue / Not started        → NewCardsSheet
 *   Directions                German → English · English → German   → DirectionsSheet
 *   Card types & fields       3 card types                     → CardTypeSheet
 *   Read aloud                German / English                 → ReadAloudSheet
 *   Noun genders (German)     [toggle]   (only when a term language is German)
 *   Check known cards         [toggle]
 *   Pause deck                [toggle]   "Paused decks don't add cards to Today. You can still study them here."
 *
 * Every row does what it says: a row opens its sheet, a toggle writes the
 * deck at once (`updateDeck` / `setDeckOptions`, called by the page).
 * Glossary words get a "?" (InfoButton): Known check, Pause a deck.
 */
import React from 'react';
import { Text, View } from 'react-native';

import { InfoButton } from '@/components/sheets/InfoButton';
import { ListRow, Row, SectionHead, Toggle } from '@/components/ui';
import type { Deck } from '@/domain/model';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { ARRIVAL_LABELS, DECK_COPY, NEW_ORDER_LABELS, newPerDayLabel } from './deckPageLogic';

/** The sheets the rows open. */
export type DeckSheet = 'newCards' | 'directions' | 'cardTypes' | 'readAloud';

interface DeckSettingsProps {
  deck: Deck;
  /** settings.srs.dailyNewLimit, for "Use my daily limit (10)". */
  dailyNewLimit: number;
  /** "German → English · English → German"; '' = the deck has no card type with two directions (no row). */
  directionsSummary: string;
  /** "3 card types" / "Basic"; '' = the deck has no card yet (no row). */
  cardTypesSummary: string;
  /** "German / English" / "Device voice". */
  readAloudSummary: string;
  /** True when a term field of the deck is German: the "Noun genders" row. */
  showGenders: boolean;
  onOpen: (sheet: DeckSheet) => void;
  onGenders: (on: boolean) => void;
  onKnownChecks: (on: boolean) => void;
  onPause: (paused: boolean) => void;
}

export function DeckSettings({
  deck,
  dailyNewLimit,
  directionsSummary,
  cardTypesSummary,
  readAloudSummary,
  showGenders,
  onOpen,
  onGenders,
  onKnownChecks,
  onPause,
}: DeckSettingsProps) {
  const c = useColors();
  const options = deck.options;
  return (
    <View>
      <SectionHead>{DECK_COPY.settingsHead}</SectionHead>
      <ListRow
        icon="add-circle-outline"
        title="New cards per day"
        sub={newPerDayLabel(options.newPerDay, dailyNewLimit)}
        onPress={() => onOpen('newCards')}
      />
      <ListRow
        icon="swap-vertical-outline"
        title="New card order"
        sub={NEW_ORDER_LABELS[options.newOrder] ?? NEW_ORDER_LABELS.source}
        onPress={() => onOpen('newCards')}
      />
      <ListRow
        icon="enter-outline"
        title="New cards arrive as"
        sub={ARRIVAL_LABELS[options.newArrival] ?? ARRIVAL_LABELS.queued}
        onPress={() => onOpen('newCards')}
      />
      {directionsSummary ? (
        <ListRow
          icon="git-compare-outline"
          title="Directions"
          sub={directionsSummary}
          onPress={() => onOpen('directions')}
        />
      ) : null}
      {cardTypesSummary ? (
        <ListRow
          icon="albums-outline"
          title="Card types & fields"
          sub={cardTypesSummary}
          onPress={() => onOpen('cardTypes')}
        />
      ) : null}
      <ListRow
        icon="volume-high-outline"
        title="Read aloud"
        sub={readAloudSummary}
        onPress={() => onOpen('readAloud')}
      />

      {showGenders ? (
        <ToggleRow
          title="Noun genders (German)"
          sub="Colour der, die and das"
          on={deck.genderColors !== false}
          onChange={onGenders}
        />
      ) : null}
      <ToggleRow
        title="Check known cards"
        sub="A few Known cards come back once for a Check"
        on={options.knownChecks !== false}
        onChange={onKnownChecks}
        info="Check"
      />
      <ToggleRow
        title="Pause deck"
        on={!deck.active}
        onChange={onPause}
        info="Pause a deck"
        last
      />
      <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 4 }]}>
        {DECK_COPY.pauseHint}
      </Text>
    </View>
  );
}

/** A title (+ a quiet second line) with a switch on the right, and an optional "?". */
function ToggleRow({
  title,
  sub,
  on,
  onChange,
  info,
  last,
}: {
  title: string;
  sub?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  info?: string;
  last?: boolean;
}) {
  const c = useColors();
  return (
    <Row padV={12} last={last}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={[font('sans', 700), { fontSize: 15, color: c.ink, flexShrink: 1 }]}>{title}</Text>
          {info ? <InfoButton term={info} /> : null}
        </View>
        {sub ? <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>{sub}</Text> : null}
      </View>
      <Toggle on={on} onChange={onChange} label={title} />
    </Row>
  );
}
