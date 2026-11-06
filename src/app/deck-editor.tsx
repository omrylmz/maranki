/**
 * Deck editor (spec §8.10, unit W3-6; wave 4 unit W4-3) — create a deck, or
 * rename one.
 *
 *   /deck-editor            a new deck; "Create deck" → the new deck's page
 *                           (`router.replace('/deck/' + id)`), which says
 *                           "This deck is empty" with "Add your first card"
 *   /deck-editor?deckId=…   "Rename and icon" from the deck page's ⋯ menu
 *                           (a deckId that is gone: "This deck no longer
 *                           exists" · Close — never the "New deck" form)
 *
 * A deck has: a name, an icon (emoji grid or "Type any emoji"), an optional
 * description, a card type for the cards you type ("Basic" or "Basic +
 * reverse" = both directions), and optional languages ("Front language" /
 * "Back language", used by read-aloud and the German helpers).
 *
 * "Card type" shows the card type new cards of the deck REALLY start with in
 * the card editor (roles.deckCardTypeChoices = roles.newCardTypeId). An
 * imported German deck shows "German Vocabulary (bidirectional)", not
 * "Basic" (review of walkthrough L10). Every choice takes effect when saved:
 * a changed card type is saved with `defaultTypeChosen: true` ("the learner
 * chose it"). So Basic stays a real choice in an imported deck too (wave
 * 5c): without the flag, a saved Basic looks like the Basic every deck gets
 * when it is made, and the deck's own card type would win again.
 * Basic and Basic + reverse fit a SegCtrl; a deck with a card type of its own
 * gets a list instead (its long name does not fit half a SegCtrl).
 *
 * Wave 4: "Duplicate deck" and "Delete deck…" moved to the deck page's ⋯
 * menu (src/app/deck/[id].tsx, DeleteDeckSheet), so this screen only edits
 * the deck's own fields. Every way out with unsaved changes asks first (M9).
 */
import * as Speech from 'expo-speech';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { Btn, Chip, Field, Ion, ListRow, Overline, Row, SegCtrl, Sheet, SnackbarHost, StackBar } from '@/components/ui';
import { BUILTIN_TYPE_IDS } from '@/domain/builtinTypes';
import { deckEditorStart, firstGlyph, noteIdsInDeck, sortDecks } from '@/domain/fieldText';
import { COMMON_LANGS, langLabel, mergeLangs } from '@/domain/lang';
import { DEFAULT_DECK_ICON, nextDeckOrder } from '@/domain/makeV3';
import type { DataStateV3, Deck } from '@/domain/model';
import { deckCardTypeChoices, type DeckTypeChoice, type DeckTypeChoices } from '@/domain/roles';
import { plural } from '@/domain/text';
import type { Actions } from '@/store/actions';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/* ------------------------------------------------------------ the store */

/** The v3 store calls this screen makes (spec §3.6). */
type DeckEditorActions = Pick<Actions, 'addDeck' | 'updateDeck' | 'reorderDecks'>;

/**
 * The store, typed as the v3 note model (same as the card editor): the v3
 * decks and the v3 actions this screen calls (spec §3.6). The return type
 * lets tsc check that useData() really gives them (W3-1: types.ts =
 * model.ts; W3-2: the engine implements `Actions`).
 */
function useDeckStore(): { state: DataStateV3; actions: DeckEditorActions } {
  const data = useData();
  return { state: data.state, actions: data.actions };
}

/* -------------------------------------------------------------- constants */

const ICONS = [
  '🗂️', '📚', '🧠', '🔤', '🧮', '🌍', '🎯', '🎓',
  '⭐', '📖', '✏️', '💬', '🗣️', '🧪', '🔬', '💻',
  '🎵', '🎨', '🏛️', '⚖️', '🩺', '🍳', '🌱', '🧭',
];

/** The card types with short names that a SegCtrl can hold (spec §8.10 "Basic" / "Basic + reverse"). */
const SEGMENT_TYPE_IDS: ReadonlySet<string> = new Set([BUILTIN_TYPE_IDS.basic, BUILTIN_TYPE_IDS.basicReverse]);

/**
 * The "Card type" value and choices when the editor opens (spec §3.4
 * `Deck.defaultTypeId`): for a deck, what its new cards start with now; for
 * a new deck (no cards yet), Basic, with Basic and Basic + reverse.
 */
function cardTypeChoicesAtOpen(state: DataStateV3, deck: Deck | null): DeckTypeChoices {
  if (!deck) return deckCardTypeChoices(null, [], new Set(), state.noteTypes);
  return deckCardTypeChoices(deck, state.notes, noteIdsInDeck(state.cards, deck.id), state.noteTypes);
}

/** The second line of a card type in the list: what it makes, or how many items of the deck use it. */
function typeChoiceSub(choice: DeckTypeChoice): string {
  if (choice.id === BUILTIN_TYPE_IDS.basic) return 'One card: front → back';
  if (choice.id === BUILTIN_TYPE_IDS.basicReverse) return 'Two cards: front → back and back → front';
  return `${plural(choice.uses, 'item')} in this deck`;
}

type LangSide = 'front' | 'back';

/* ----------------------------------------------------------------- screen */

export default function DeckEditorScreen() {
  const c = useColors();
  const router = useRouter();
  const navigation = useNavigation();
  const { state, actions } = useDeckStore();
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ deckId?: string }>();

  // Fixed at open: a delete must not turn the closing screen into "New deck".
  // A deckId that is not in the library opens "This deck no longer exists"
  // (never the "New deck" form, which would make a second deck).
  const [start] = useState(() => deckEditorStart<Deck>(state.decks, params.deckId));
  const initial = start.kind === 'edit' ? start.deck : null;
  const editing = initial !== null;
  // Also fixed at open: the card type new cards of this deck start with NOW
  // (newCardTypeId, the card editor's rule) and the choices that take effect.
  const [typeChoices] = useState(() => cardTypeChoicesAtOpen(state, initial));
  const initialType = typeChoices.value;
  // Only Basic / Basic + reverse: the SegCtrl. A deck with a card type of its own: a list.
  const typeAsList = typeChoices.options.some((o) => !SEGMENT_TYPE_IDS.has(o.id));

  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? DEFAULT_DECK_ICON);
  const [iconDraft, setIconDraft] = useState('');
  const [desc, setDesc] = useState(initial?.desc ?? '');
  const [typeId, setTypeId] = useState<string>(initialType);
  const [language, setLanguage] = useState(initial?.language ?? '');
  const [meaningLanguage, setMeaningLanguage] = useState(initial?.meaningLanguage ?? '');
  const [langSide, setLangSide] = useState<LangSide | null>(null);
  const [voiceLangs, setVoiceLangs] = useState<string[]>([]);
  const [guard, setGuard] = useState(false);

  // The languages the phone can read aloud, added to the common list of the
  // picker (spec §9.2). The answer comes later (a promise), never in the effect body.
  useEffect(() => {
    let alive = true;
    Speech.getAvailableVoicesAsync()
      .then((voices) => {
        if (alive) setVoiceLangs(voices.map((v) => v.language));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const langs = useMemo(
    () => mergeLangs(COMMON_LANGS, voiceLangs, [language, meaningLanguage].filter(Boolean)),
    [voiceLangs, language, meaningLanguage],
  );

  const cleanName = name.trim();
  const dirty = editing
    ? cleanName !== initial.name ||
      icon !== initial.icon ||
      desc.trim() !== (initial.desc ?? '') ||
      typeId !== initialType ||
      language !== (initial.language ?? '') ||
      meaningLanguage !== (initial.meaningLanguage ?? '')
    : cleanName !== '' ||
      desc.trim() !== '' ||
      icon !== DEFAULT_DECK_ICON ||
      typeId !== initialType ||
      language !== '' ||
      meaningLanguage !== '';

  // Every way out (header ×, Android back, iOS swipe) asks first when there
  // are unsaved changes; `leaving` lets the intentional exits through (M9).
  const leaving = useRef(false);
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!dirty || leaving.current) return;
      e.preventDefault();
      setGuard(true);
    });
    return unsub;
  }, [navigation, dirty]);

  const leave = () => {
    leaving.current = true; // intentional exit — don't let the guard intercept
    router.back();
  };

  const save = () => {
    if (!cleanName) return;
    if (initial) {
      const patch: Parameters<DeckEditorActions['updateDeck']>[1] = {};
      if (cleanName !== initial.name) patch.name = cleanName;
      if (icon !== initial.icon) patch.icon = icon;
      if (desc.trim() !== (initial.desc ?? '')) patch.desc = desc.trim() || undefined;
      if (typeId !== initialType) {
        // The learner chose it: a Basic saved here wins over the deck's own card type (roles.newCardTypeId rule 1).
        patch.defaultTypeId = typeId;
        patch.defaultTypeChosen = true;
      }
      if (language !== (initial.language ?? '')) patch.language = language || undefined;
      if (meaningLanguage !== (initial.meaningLanguage ?? '')) patch.meaningLanguage = meaningLanguage || undefined;
      if (Object.keys(patch).length > 0) {
        actions.updateDeck(initial.id, patch);
        show('Deck saved');
      }
      leave();
      return;
    }

    // A new deck goes to the END of the deck list (order = nextDeckOrder).
    const lastOrder = nextDeckOrder(state.decks);
    const created = actions.addDeck({
      name: cleanName,
      icon,
      defaultTypeId: typeId,
      ...(desc.trim() ? { desc: desc.trim() } : {}),
      ...(language ? { language } : {}),
      ...(meaningLanguage ? { meaningLanguage } : {}),
    });
    // addDeck has no `order` input. If the reducer did not put the deck last,
    // put it there now, so it never jumps to the top of the lists.
    if (!(created.order >= lastOrder)) {
      actions.reorderDecks([...sortDecks(state.decks).map((d) => d.id), created.id]);
    }
    show(`Deck “${cleanName}” created`);
    // The new deck's page replaces this editor (spec §8.10): it shows "This
    // deck is empty" with "Add your first card". `leaving` lets the exit
    // through the unsaved-changes guard (the deck IS saved).
    leaving.current = true;
    router.replace({ pathname: '/deck/[id]', params: { id: created.id } });
  };

  // The caller asked for a deck that is gone: say so, with one way out (after
  // every hook above, so the hooks run in the same order on every render).
  if (start.kind === 'missing') {
    return (
      <View style={{ flex: 1, backgroundColor: c.paper }}>
        <StackBar title="Edit deck" backIcon="close" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Ion name="help-circle-outline" size={40} color={c.ink3} />
          <Text
            accessibilityRole="header"
            style={[font('serif', 600), { fontSize: 20, color: c.ink, marginTop: 14, textAlign: 'center' }]}
          >
            This deck no longer exists
          </Text>
          <Text
            style={[
              font('sans', 400),
              { fontSize: 13.5, color: c.ink3, marginTop: 6, marginBottom: 18, textAlign: 'center', lineHeight: 20 },
            ]}
          >
            It may have been deleted.
          </Text>
          <Btn onPress={() => router.back()}>Close</Btn>
        </View>
        <SnackbarHost aboveTabBar={false} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title={editing ? 'Edit deck' : 'New deck'}
        backIcon="close"
        onBack={() => (dirty ? setGuard(true) : router.back())}
        right={
          <Btn size="sm" disabled={!cleanName} onPress={save}>
            {editing ? 'Save' : 'Create deck'}
          </Btn>
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Field
            label="Deck name *"
            value={name}
            onChange={setName}
            placeholder="World capitals"
            autoFocus={!editing}
          />

          <Overline style={{ marginTop: 4, marginBottom: 7 }}>Icon</Overline>
          <View style={{ flexDirection: 'row', gap: 7, marginBottom: 10, flexWrap: 'wrap' }}>
            {ICONS.map((ic) => (
              <Chip
                key={ic}
                active={icon === ic}
                onPress={() => {
                  setIcon(ic);
                  setIconDraft('');
                }}
              >
                {ic}
              </Chip>
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <TextInput
              value={iconDraft}
              onChangeText={(text) => {
                setIconDraft(text);
                const glyph = firstGlyph(text);
                if (glyph) setIcon(glyph);
              }}
              placeholder="Type any emoji"
              placeholderTextColor={c.ink3}
              accessibilityLabel="Type any emoji"
              autoCorrect={false}
              style={[
                font('sans', 400),
                {
                  flex: 1,
                  backgroundColor: c.card,
                  borderWidth: 1,
                  borderColor: ICONS.includes(icon) ? c.hairlineStrong : c.pine,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  fontSize: 15.5,
                  color: c.ink,
                },
              ]}
            />
            <View
              accessibilityLabel={`Chosen icon ${icon}`}
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                backgroundColor: c.paperSunk,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 24 }}>{icon}</Text>
            </View>
          </View>

          <Field
            label="Description"
            value={desc}
            onChange={setDesc}
            placeholder="What lives in this deck?"
            multiline
          />

          <Overline style={{ marginTop: 4, marginBottom: typeAsList ? 0 : 7 }}>Card type</Overline>
          {typeAsList ? (
            <TypeChoiceList options={typeChoices.options} value={typeId} onChange={setTypeId} />
          ) : (
            <SegCtrl
              label="Card type"
              options={typeChoices.options.map((o) => ({ id: o.id, label: o.name }))}
              value={typeId}
              onChange={setTypeId}
            />
          )}
          <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginTop: 6, marginBottom: 18, lineHeight: 17 }]}>
            {typeAsList
              ? 'For cards you add from now on. To add one card of another type, choose it in the card editor.'
              : editing
                ? 'For cards you add from now on. Basic + reverse makes two cards: front → back and back → front.'
                : 'Basic makes one card: front → back. Basic + reverse makes two: front → back and back → front.'}
          </Text>

          <Overline style={{ marginBottom: 2 }}>Languages</Overline>
          <ListRow
            icon="language-outline"
            title="Front language"
            sub={language ? langLabel(language) : 'Not set'}
            onPress={() => setLangSide('front')}
          />
          <ListRow
            icon="language-outline"
            title="Back language"
            sub={meaningLanguage ? langLabel(meaningLanguage) : 'Not set'}
            onPress={() => setLangSide('back')}
            last
          />
          <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginTop: 4, marginBottom: 18, lineHeight: 17 }]}>
            Optional. Used to read cards aloud, and for German noun genders.
          </Text>

        </ScrollView>
      </KeyboardAvoidingView>

      <LanguageSheet
        side={langSide}
        onClose={() => setLangSide(null)}
        value={langSide === 'back' ? meaningLanguage : language}
        langs={langs}
        onPick={(tag) => (langSide === 'back' ? setMeaningLanguage(tag) : setLanguage(tag))}
      />

      {/* unsaved-changes guard (M9) */}
      <Sheet open={guard} onClose={() => setGuard(false)} title="Discard changes?">
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          {editing ? 'Your edits to this deck haven’t been saved.' : 'This deck hasn’t been created yet.'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setGuard(false)}>
            Keep editing
          </Btn>
          <Btn
            kind="danger"
            full
            style={{ flex: 1 }}
            onPress={() => {
              setGuard(false);
              leave(); // confirmed discard — let this exit through
            }}
          >
            Discard
          </Btn>
        </View>
      </Sheet>

      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}

/**
 * "Card type" as a list, for a deck with a card type of its own: one row per
 * choice (name + what it makes, or how many items use it), the chosen one
 * with a check mark. A screen reader hears each row as a radio button with
 * its checked state.
 */
function TypeChoiceList({
  options,
  value,
  onChange,
}: {
  options: readonly DeckTypeChoice[];
  value: string;
  onChange: (typeId: string) => void;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Card type">
      {options.map((o, i) => {
        const on = o.id === value;
        const sub = typeChoiceSub(o);
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${o.name}. ${sub}`}
            style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 12,
                borderBottomWidth: i === options.length - 1 ? 0 : 1,
                borderBottomColor: c.hairlineSoft,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>{o.name}</Text>
                <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>{sub}</Text>
              </View>
              {on ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Choose a language for one side ("None" clears it). `side` null = closed. */
function LanguageSheet({
  side,
  onClose,
  value,
  langs,
  onPick,
}: {
  side: LangSide | null;
  onClose: () => void;
  value: string;
  langs: string[];
  onPick: (tag: string) => void;
}) {
  const c = useColors();
  const rows = [{ tag: '', label: 'None' }, ...langs.map((tag) => ({ tag, label: langLabel(tag) }))];
  return (
    <Sheet open={side !== null} onClose={onClose} title={side === 'back' ? 'Back language' : 'Front language'}>
      {rows.map((r, i) => (
        <Row
          key={r.tag || 'none'}
          last={i === rows.length - 1}
          padV={12}
          onPress={() => {
            onPick(r.tag);
            onClose();
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>
              {r.label}
            </Text>
            {r.tag ? (
              <Text style={[font('mono', 400), { fontSize: 12, color: c.ink3 }]}>{r.tag}</Text>
            ) : null}
          </View>
          {r.tag === value ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
        </Row>
      ))}
    </Sheet>
  );
}
