/**
 * Card editor (spec §8.10, unit W3-6) — add or edit a card AS A NOTE.
 *
 *   /card-editor?noteId=…   edit that note
 *   /card-editor?cardId=…   edit the note of that card (old callers, CardPeek)
 *   /card-editor?deckId=…&typeId=…   a new card, deck and card type preset
 *
 * A note is the information you enter once; it has one card per direction
 * (glossary §1.2). So an edit changes EVERY direction, and "Delete card…"
 * deletes the item with all its directions (the screen says so).
 *
 * What the learner gets:
 *   - every field of the card type, with its label (an imported Anki type
 *     shows all its fields); multiline boxes; a field that holds HTML is
 *     edited as text with real line breaks (<br> ↔ newline, fieldText.ts) and
 *     an unchanged field is saved byte for byte;
 *   - a new card goes to the caller's deck, else the LAST USED deck (never
 *     simply the oldest one, spec §7 #50); the card type can be chosen. It
 *     starts as the caller's type, else the deck's own card type
 *     (roles.newCardTypeId: an imported German deck starts its new cards as
 *     "German Vocabulary", the type most of its items use — not as Basic,
 *     walkthrough L10), else Basic;
 *   - every field label is the field's display label (render.ts
 *     fieldDisplayLabel): "MarankiExample" shows as "Example", "VerbForms"
 *     as "Verb Forms" (walkthrough L3 / R6), also in the card type list;
 *   - "Save & add another": keeps deck, type and tags, clears the fields,
 *     scrolls back to the top and puts the cursor into the first field,
 *     counts "{n} added" and offers Undo ("Added · Undo");
 *   - the snackbar ("Added · Undo", "This card could not be added.") sits at
 *     the TOP of the form, under the bar (EditorSnackbar), never at the
 *     bottom where "Save & add another" is (wave 5c);
 *   - a same-deck duplicate warning ("“comer” is already in this deck · View it");
 *   - the unsaved-changes guard on every way out (M9) and a guarded delete (L6).
 *
 * All the rules live in src/domain/fieldText.ts (pure, tested). This file
 * holds React state and layout only.
 */
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { CardTypePicker } from '@/components/editor/CardTypePicker';
import { DeckField, DeckPickerSheet } from '@/components/editor/DeckPickerSheet';
import { FieldInput } from '@/components/editor/FieldInput';
import { TagInput } from '@/components/editor/TagInput';
import { Btn, Ion, ListRow, Sheet, SnackbarHost, SnackbarView, StackBar } from '@/components/ui';
import { builtinType } from '@/domain/builtinTypes';
import {
  cardTypeOptions,
  carryFields,
  checksDuplicate,
  duplicateIndex,
  fieldsForSave,
  findDuplicate,
  fromEditable,
  isBlankField,
  isFormatted,
  lastUsedDeckId,
  missingFields,
  noteIdsInDeck,
  splitFields,
  tagSuggestions,
  tagsWithDraft,
  toEditable,
  typeById,
} from '@/domain/fieldText';
import { plainText } from '@/domain/libraryIndex';
import type { DataStateV3, Deck, Id, Note, NoteType } from '@/domain/model';
import { fieldDisplayLabel, fieldShownOnCard } from '@/domain/render';
import { newCardTypeId } from '@/domain/roles';
import { cardLookupOf } from '@/domain/scope';
import { oneLine } from '@/domain/text';
import type { Actions } from '@/store/actions';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/* ------------------------------------------------------------ the store */

/** The v3 store calls this screen makes (spec §3.6). */
type EditorActions = Pick<Actions, 'addNote' | 'editNote' | 'moveNotes' | 'deleteNotes' | 'undoDelete'>;

/**
 * The store, typed as the v3 note model: the v3 data (notes, card types) and
 * the v3 actions this screen calls (spec §3.6). The return type lets tsc
 * check that useData() really gives them (W3-1: `DataState` = `DataStateV3`;
 * W3-2: the engine implements `Actions`).
 */
function useNoteStore(): { state: DataStateV3; actions: EditorActions } {
  const data = useData();
  return { state: data.state, actions: data.actions };
}

/* ------------------------------------------------------- opening the editor */

interface Params {
  noteId?: string;
  cardId?: string;
  deckId?: string;
  typeId?: string;
}

/** What the editor works on, fixed when the screen opens. */
interface EditorStart {
  /** The note being edited; null = a new card. */
  note: Note | null;
  /** The caller asked to edit a note or card that does not exist (any more). */
  missing: boolean;
  /** The deck: the note's deck, or the deck for a new card. */
  deckId: Id | null;
  /** The card type (for a new card: the preset or the deck's default). */
  type: NoteType;
  /** True when the caller chose the card type (typeId), so a deck change keeps it. */
  typePreset: boolean;
  /** The stored field values ('' for a new card), aligned with `type.fields`. */
  raw: string[];
  /** The same values as editable text (toEditable). */
  editable: string[];
  tags: string[];
}

const basicType = () => builtinType('basic', 0);

/**
 * The card type a new card in `deck` starts with (roles.newCardTypeId): the
 * deck's chosen type, else the type most of the deck's items use when the
 * deck holds a card type of its own (an imported deck), else Basic.
 */
function newCardType(state: Pick<DataStateV3, 'notes' | 'noteTypes' | 'cards'>, deck: Deck | null): NoteType {
  if (!deck) return basicType();
  const noteIds = noteIdsInDeck(state.cards, deck.id);
  return typeById(state.noteTypes, newCardTypeId(deck, state.notes, noteIds, state.noteTypes)) ?? basicType();
}

/**
 * A copy of a card type whose fields carry their display labels, for the
 * card type list: its line then reads "Word, Grammar, Verb Forms, …", never
 * a raw name like "VerbForms". The id stays the same (a pick finds the real
 * type by id). Only the FieldDef objects are copied (never a by-name record).
 */
function withDisplayLabels(type: NoteType): NoteType {
  return { ...type, fields: type.fields.map((f) => ({ ...f, label: fieldDisplayLabel(f) })) };
}

/**
 * A card type for a note whose type is missing (broken data; checkIntegrity
 * normally repairs it): "Field 1 … N", so every value can still be edited.
 */
function recoveredType(note: Note): NoteType {
  return {
    id: note.typeId,
    name: 'Card',
    kind: 'standard',
    fields: note.fields.map((_, i) => ({ name: `Field ${i + 1}`, role: i === 0 ? 'term' : 'detail', facet: 'off' })),
    templates: [],
    sortField: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function openEditor(state: DataStateV3, params: Params): EditorStart {
  const { notes, noteTypes, cards, decks } = state;
  const wantsEdit = !!(params.noteId || params.cardId);
  const noteId = params.noteId || cards.find((c) => c.id === params.cardId)?.noteId;
  const note = noteId ? (notes.find((n) => n.id === noteId) ?? null) : null;

  if (note) {
    const type = typeById(noteTypes, note.typeId) ?? recoveredType(note);
    // All cards of a note are in one deck; the lowest-ord card is the reference (checkIntegrity's rule).
    // The note's cards come from scope.ts's shared lookup (no filter over state.cards: W5-2 guard).
    const { cardById, cardIdsByNote } = cardLookupOf(cards);
    const siblings = (cardIdsByNote.get(note.id) ?? []).flatMap((id) => cardById.get(id) ?? []);
    const home = siblings.sort((a, b) => a.ord - b.ord)[0];
    const raw = type.fields.map((_, i) => note.fields[i] ?? '');
    return {
      note,
      missing: false,
      deckId: home?.deckId ?? null,
      type,
      typePreset: true,
      raw,
      editable: raw.map(toEditable),
      tags: [...note.tags],
    };
  }

  const deckId =
    params.deckId && decks.some((d) => d.id === params.deckId) ? params.deckId : lastUsedDeckId(state);
  const deck = decks.find((d) => d.id === deckId);
  const preset = typeById(noteTypes, params.typeId);
  const type = preset ?? newCardType(state, deck ?? null);
  const blank = type.fields.map(() => '');
  return {
    note: null,
    missing: wantsEdit,
    deckId: deckId ?? null,
    type,
    typePreset: preset !== null,
    raw: blank,
    editable: blank,
    tags: [],
  };
}

/* ---------------------------------------------------------------- helpers */

/** One short line of a field for snackbars and the duplicate warning. */
function shortText(raw: string, max = 40): string {
  const text = oneLine(plainText(raw));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Example text for the fields of the built-in types (the other types have none). */
function placeholderFor(type: NoteType, i: number): string | undefined {
  if (type.builtin === 'basic' || type.builtin === 'basicReverse') {
    return ['Capital of France', 'Paris', 'Paris is the capital and largest city of France.', 'Any extra context or a mnemonic'][i];
  }
  if (type.builtin === 'cloze') return ['{{c1::Paris}} is the capital of France.', 'Any extra context'][i];
  return undefined;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Where the editor's snackbar sits: this far (pt) below the top of the form, under the bar. */
const EDITOR_SNACK_TOP = 8;

/**
 * The global snackbar of the editor, drawn at the TOP of the form (just
 * under the "New card" bar), not at the bottom like SnackbarHost.
 *
 * WHY (wave 5c, review of walkthrough M5): "Save & add another" shows
 * "Added · Undo" for 6 s, and its Undo deletes the card just added. At the
 * bottom of the screen, the Undo could sit right over "Save & add another"
 * (the right button of the Save row) when the Save row was scrolled to the
 * bottom edge: a quick tap meant for the next "Save & add another" hit Undo,
 * the card just added was deleted and the card being typed was not saved.
 * At the top it lies over the Deck field, which the learner rarely taps
 * while adding cards; and "Save & add another" scrolls the form back to the
 * top, so the first field is below the bar, never under it.
 *
 * The same channel as SnackbarHost (useSnackbar): an Undo closes the bar.
 */
function EditorSnackbar() {
  const { snack, dismiss } = useSnackbar();
  if (!snack) return null;
  const action = snack.onAction;
  return (
    <SnackbarView
      text={snack.text}
      actionLabel={snack.actionLabel}
      onAction={
        action
          ? () => {
              action();
              dismiss();
            }
          : undefined
      }
      top={EDITOR_SNACK_TOP}
    />
  );
}

/* ----------------------------------------------------------------- screen */

export default function CardEditorScreen() {
  const c = useColors();
  const router = useRouter();
  const navigation = useNavigation();
  const { state, actions } = useNoteStore();
  const { notes, noteTypes, cards, decks } = state;
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ noteId?: string; cardId?: string; deckId?: string; typeId?: string }>();

  // Fixed at open: a save or delete must not turn the closing screen into "New card".
  const [start] = useState(() => openEditor(state, params));
  const editingNote = start.note;
  const editing = editingNote !== null;

  const [deckId, setDeckId] = useState<Id | null>(start.deckId);
  const [newType, setNewType] = useState<NoteType>(start.type);
  const [typePicked, setTypePicked] = useState(start.typePreset);
  const [values, setValues] = useState<string[]>(start.editable);
  const [tags, setTags] = useState<string[]>(start.tags);
  const [draft, setDraft] = useState('');
  /** The tags a clean form has: the note's tags, or the tags kept by "Save & add another". */
  const [baseTags, setBaseTags] = useState<string[]>(start.tags);
  const [showMore, setShowMore] = useState(false);
  const [added, setAdded] = useState(0);
  const [guard, setGuard] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);
  const [pickingDeck, setPickingDeck] = useState(false);
  const firstRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  const type = editing ? start.type : newType;
  const deck = decks.find((d) => d.id === deckId) ?? null;
  const split = useMemo(() => splitFields(type), [type]);

  const deckNoteIds = useMemo(() => noteIdsInDeck(cards, deckId), [cards, deckId]);
  // The list reads display labels ("Verb Forms"), so it is built from labelled copies (same ids).
  const labelledTypes = useMemo(() => noteTypes.map(withDisplayLabels), [noteTypes]);
  const typeOptions = useMemo(
    () => cardTypeOptions(labelledTypes, notes, deckNoteIds, withDisplayLabels(type)),
    [labelledTypes, notes, deckNoteIds, type],
  );
  const dupIndex = useMemo(() => duplicateIndex(notes, deckNoteIds, type), [notes, deckNoteIds, type]);
  const cardCounts = useMemo(() => {
    const m = new Map<Id, number>();
    for (const card of cards) m.set(card.deckId, (m.get(card.deckId) ?? 0) + 1);
    return m;
  }, [cards]);
  // How many cards (directions) the edited note has, from scope.ts's shared lookup (W5-2 guard).
  const noteCardCount = useMemo(
    () => (editingNote ? (cardLookupOf(cards).cardIdsByNote.get(editingNote.id)?.length ?? 0) : 0),
    [cards, editingNote],
  );

  // The tags to save: the chips plus a tag still being typed.
  const effectiveTags = useMemo(() => tagsWithDraft(tags, draft), [tags, draft]);
  // Only tags that start with the word being typed: a tap finishes that word (TagInput).
  const suggestions = useMemo(
    () => tagSuggestions(notes, deckNoteIds, effectiveTags, 8, draft),
    [notes, deckNoteIds, effectiveTags, draft],
  );

  const fieldsDirty = editing
    ? values.some((v, i) => v !== (start.editable[i] ?? ''))
    : values.some((v) => v !== '');
  const tagsDirty = !sameTags(effectiveTags, baseTags);
  const deckMoved = editing && deckId !== start.deckId;
  const dirty = fieldsDirty || tagsDirty || deckMoved;

  const missing = missingFields(type, values, editing ? start.editable : undefined);
  const valid = missing.length === 0 && (editing || deck !== null);

  // The duplicate warning: for a new card, or when an edit changed the sort
  // field or moves the note into another deck (that deck may have it already).
  const sortIndex = type.sortField;
  const checkDup = checksDuplicate({
    editing,
    deckMoved,
    sortText: values[sortIndex] ?? '',
    startSortText: start.editable[sortIndex] ?? '',
  });
  const sortRaw = fromEditable(values[sortIndex] ?? '');
  const dupId = checkDup ? findDuplicate(dupIndex, sortRaw, editingNote?.id) : null;

  // The header back button is guarded below, but Android hardware-back and the
  // iOS edge-swipe slip past it and silently discard edits. `beforeRemove`
  // intercepts EVERY exit cause; `leaving` lets the intentional exits (save,
  // delete, confirmed discard) through so the guard never blocks its own
  // navigation and traps the user (M9).
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

  const setField = (i: number, text: string) =>
    setValues((prev) => {
      const next = [...prev];
      next[i] = text;
      return next;
    });

  /** A new card type: keep the typed text in the fields that match (carryFields). */
  const switchType = (next: NoteType) => {
    if (next.id === type.id) return;
    setValues(carryFields(type, values, next));
    setNewType(next);
  };

  const pickType = (typeId: Id) => {
    const next = typeById(noteTypes, typeId);
    if (!next) return;
    setTypePicked(true);
    switchType(next);
  };

  const pickDeck = (id: Id) => {
    // A new card follows the deck's own card type, until the learner picks one.
    if (!editing && !typePicked) {
      const nextDeck = decks.find((d) => d.id === id) ?? null;
      switchType(newCardType({ notes, noteTypes, cards }, nextDeck));
    }
    setDeckId(id);
  };

  /** The headline of the card being saved, for the snackbar. */
  const headline = () => shortText(fromEditable(values[split.main[0] ?? 0] ?? '')) || 'Card';

  /** Add the form as a new note. Returns its id, or null when nothing was added. */
  const addCurrent = (): Id | null => {
    if (!valid || !deck) return null;
    const result = actions.addNote({
      deckId: deck.id,
      typeId: type.id,
      // A new card has no stored text yet: every field is converted (fieldsForSave with no "before").
      fields: fieldsForSave([], [], values),
      tags: effectiveTags,
    });
    if (!result?.noteId || result.cardIds.length === 0) {
      show('This card could not be added.');
      return null;
    }
    return result.noteId;
  };

  const saveEdit = (note: Note) => {
    if (!dirty) {
      leave();
      return;
    }
    const patch: { fields?: string[]; tags?: string[] } = {};
    if (fieldsDirty) patch.fields = fieldsForSave(start.raw, start.editable, values);
    if (tagsDirty) patch.tags = effectiveTags;
    if (patch.fields || patch.tags) actions.editNote(note.id, patch);
    // A move is per note: all its directions go to the new deck together.
    if (deckMoved && deck) actions.moveNotes([note.id], deck.id);
    show(deckMoved && deck ? `Card saved — moved to ${deck.name}` : 'Card saved');
    leave();
  };

  const save = () => {
    if (!valid) return;
    if (editingNote) {
      saveEdit(editingNote);
      return;
    }
    const label = headline();
    if (addCurrent() === null) return;
    show(`“${label}” added`);
    leave();
  };

  const saveAndAddAnother = () => {
    const noteId = addCurrent();
    if (noteId === null) return;
    setAdded((n) => n + 1);
    // Keep deck, type and tags; clear the fields; back to the top, and the cursor into the first field.
    // At the top, the first field is below the "Added · Undo" bar (EditorSnackbar), never under it.
    setValues(type.fields.map(() => ''));
    setTags(effectiveTags);
    setBaseTags(effectiveTags);
    setDraft('');
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    firstRef.current?.focus();
    show('Added', {
      onAction: () => {
        actions.deleteNotes([noteId]);
        setAdded((n) => Math.max(0, n - 1));
      },
    });
  };

  const deleteNote = (note: Note) => {
    const label = shortText(note.fields[type.sortField] ?? '') || 'Card';
    setDelConfirm(false);
    const token = actions.deleteNotes([note.id]);
    show(`“${label}” deleted`, { onAction: () => actions.undoDelete(token) });
    leave(); // the card is gone — don't re-prompt on the way out
  };

  /* --------------------------------------------------- the two empty screens */

  if (start.missing) {
    return (
      <EmptyEditor
        screenTitle="Edit card"
        icon="help-circle-outline"
        title="This card is no longer here"
        body="It may have been deleted."
        action="Close"
        onAction={() => router.back()}
      />
    );
  }
  // A card needs a deck to live in. On a blank slate there is none yet, so the
  // form would strand the user with a disabled Save — show a way forward instead.
  if (!editing && decks.length === 0) {
    return (
      <EmptyEditor
        screenTitle="New card"
        icon="albums-outline"
        title="No deck yet"
        body="A card lives in a deck. Make a deck first, then add cards to it."
        action="New deck"
        onAction={() => router.replace('/deck-editor')}
      />
    );
  }

  /* ------------------------------------------------------------ the form */

  // Editing shows every field of the card type, in its order (an imported type: all its
  // fields, with labels). A new card shows the main fields; the rest are under "More fields".
  // "More fields" stays open while one of them has text, so typed text is never hidden.
  const moreHasText = split.more.some((i) => (values[i] ?? '') !== '');
  const moreOpen = showMore || moreHasText;
  const topFields = editing ? type.fields.map((_, i) => i) : split.main;
  const firstIndex = topFields[0];

  const renderField = (i: number) => {
    const field = type.fields[i];
    const isMain = split.main.includes(i);
    // Editing: a main field that was empty before is not required (an imported note is never stuck).
    const required = isMain && (!editing || !isBlankField(fromEditable(start.editable[i] ?? '')));
    const reason = missing.find((m) => m.index === i)?.reason;
    const isClozeText = type.kind === 'cloze' && isMain;
    return (
      <FieldInput
        key={`${type.id}:${i}`}
        ref={i === firstIndex ? firstRef : undefined}
        label={fieldDisplayLabel(field)}
        value={values[i] ?? ''}
        onChange={(text) => setField(i, text)}
        required={required}
        formatted={editing && isFormatted(start.raw[i] ?? '')}
        placeholder={placeholderFor(type, i)}
        autoFocus={!editing && i === firstIndex}
        error={reason === 'noCloze' ? 'Add a part to hide, like {{c1::this}}.' : undefined}
        hint={
          isClozeText
            ? 'Hide a part like this: {{c1::Berlin}} is in Germany. Each number is one card.'
            : field.role === 'hidden'
              ? 'Not shown on the card. Used for search and filters.'
              : !fieldShownOnCard(type, i)
                ? 'Not shown on the card. No side of this card type uses it.'
                : undefined
        }
      />
    );
  };

  const directionsNote =
    noteCardCount === 2 ? 'Changes both directions' : noteCardCount > 2 ? `Changes all ${noteCardCount} directions` : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar
        title={editing ? 'Edit card' : 'New card'}
        sub={editing ? directionsNote : undefined}
        backIcon="close"
        onBack={() => (dirty ? setGuard(true) : router.back())}
        right={
          editing ? (
            <Btn size="sm" disabled={!valid} onPress={save}>
              Save
            </Btn>
          ) : undefined
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <DeckField deck={deck} onPress={() => setPickingDeck(true)} />
          {!editing ? <CardTypePicker options={typeOptions} value={type.id} onChange={pickType} /> : null}

          {topFields.map(renderField)}

          {!editing && split.more.length > 0 ? (
            <>
              {!moreHasText ? (
                <Pressable
                  onPress={() => setShowMore((open) => !open)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showMore }}
                  hitSlop={6}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, marginBottom: 10 }}
                >
                  <Ion name={showMore ? 'chevron-down' : 'chevron-forward'} size={16} color={c.ink2} />
                  <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2 }]}>More fields</Text>
                  <Text numberOfLines={1} style={[font('sans', 400), { flex: 1, fontSize: 12.5, color: c.ink3 }]}>
                    {split.more.map((i) => fieldDisplayLabel(type.fields[i])).join(', ')}
                  </Text>
                </Pressable>
              ) : null}
              {moreOpen ? split.more.map(renderField) : null}
            </>
          ) : null}

          <TagInput
            tags={tags}
            draft={draft}
            onChangeTags={setTags}
            onChangeDraft={setDraft}
            suggestions={suggestions}
          />

          {dupId ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                backgroundColor: c.warningTint,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                marginBottom: 16,
              }}
            >
              <Ion name="warning-outline" size={17} color={c.warning} />
              <View style={{ flex: 1, alignItems: 'flex-start' }}>
                <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink, lineHeight: 19 }]}>
                  {`“${shortText(sortRaw)}” is already in this deck.`}
                </Text>
                {/* A real button (a 44 pt target with its slop), not a link inside the sentence (about 19 pt). */}
                <Btn
                  size="sm"
                  kind="ghost"
                  style={{ marginLeft: -15, marginTop: 2 }}
                  onPress={() => router.push({ pathname: '/card-editor', params: { noteId: dupId } })}
                >
                  View it
                </Btn>
              </View>
            </View>
          ) : null}

          {!editing ? (
            <>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <Btn kind="secondary" full style={{ flex: 1 }} disabled={!valid} onPress={save}>
                  Save
                </Btn>
                <Btn full style={{ flex: 1.5 }} disabled={!valid} onPress={saveAndAddAnother}>
                  Save & add another
                </Btn>
              </View>
              {added > 0 ? (
                <Text style={[font('sans', 600), { fontSize: 13, color: c.ink3, marginTop: 12, textAlign: 'center' }]}>
                  {`${added.toLocaleString('en-US')} added`}
                </Text>
              ) : null}
            </>
          ) : (
            <View
              style={{
                borderWidth: 1,
                borderColor: c.danger + '4D',
                borderRadius: 14,
                paddingVertical: 2,
                paddingHorizontal: 14,
                backgroundColor: c.danger + '0A',
                marginTop: 8,
              }}
            >
              <ListRow
                icon="trash-outline"
                danger
                title="Delete card…"
                sub={
                  noteCardCount === 2
                    ? 'Deletes both directions and their progress'
                    : noteCardCount > 2
                      ? `Deletes all ${noteCardCount} directions and their progress`
                      : 'Its study progress goes with it'
                }
                last
                onPress={() => setDelConfirm(true)}
              />
            </View>
          )}
        </ScrollView>
        {/* The snackbar at the TOP of the form, over the Deck field: never over "Save & add another". */}
        <EditorSnackbar />
      </KeyboardAvoidingView>

      <DeckPickerSheet
        open={pickingDeck}
        onClose={() => setPickingDeck(false)}
        decks={decks}
        selectedId={deckId}
        cardCounts={cardCounts}
        onPick={pickDeck}
        title={editing ? 'Move to deck' : 'Choose a deck'}
      />

      {/* unsaved-changes guard (M9) */}
      <Sheet open={guard} onClose={() => setGuard(false)} title="Discard changes?">
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          Your edits to this card haven’t been saved.
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

      {/* guarded delete (L6) — destructive, so it confirms before removing */}
      <Sheet open={delConfirm} onClose={() => setDelConfirm(false)} title="Delete this card?">
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginBottom: 18 }]}>
          {`“${editingNote ? shortText(editingNote.fields[type.sortField] ?? '') || 'This card' : ''}” and its study progress will be removed.`}
          {noteCardCount > 1 ? ` This deletes all ${noteCardCount} directions of it.` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setDelConfirm(false)}>
            Cancel
          </Btn>
          <Btn
            kind="dangerSolid"
            full
            style={{ flex: 1 }}
            onPress={() => {
              if (editingNote) deleteNote(editingNote);
            }}
          >
            Delete card
          </Btn>
        </View>
      </Sheet>
    </View>
  );
}

/** A full-screen message with one way forward (no deck yet, or the card is gone). */
function EmptyEditor({
  screenTitle,
  icon,
  title,
  body,
  action,
  onAction,
}: {
  screenTitle: string;
  icon: string;
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  const c = useColors();
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title={screenTitle} backIcon="close" onBack={() => router.back()} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Ion name={icon} size={40} color={c.ink3} />
        <Text style={[font('serif', 600), { fontSize: 20, color: c.ink, marginTop: 14, textAlign: 'center' }]}>
          {title}
        </Text>
        <Text
          style={[
            font('sans', 400),
            { fontSize: 13.5, color: c.ink3, marginTop: 6, marginBottom: 18, textAlign: 'center', lineHeight: 20 },
          ]}
        >
          {body}
        </Text>
        <Btn icon={action === 'New deck' ? 'add' : undefined} onPress={onAction}>
          {action}
        </Btn>
      </View>
      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}
