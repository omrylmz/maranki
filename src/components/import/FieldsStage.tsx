/**
 * Import wizard — the "Fields" stage (spec §5.3, §5.9). Nothing is imported yet.
 *
 * One card per source card type of the chosen sections:
 *
 *   German Vocabulary · 6,845 items
 *   Front         [ Word ▾ ]
 *   Back          [ Translation ▾ ]
 *   Examples      Example (94% filled) · Examples (45% filled)   [Change]
 *   Shown on back ☑ Grammar  ☑ Verb Forms
 *   Filters       ☑ Level (5 values)
 *   Directions    ☑ German → English   ☑ English → German
 *   Read aloud    Front: [German ▾]   Back: [English ▾]
 *   ┌ sample ‹ 1 / 6,845 › ┐  die Abfahrt → departure   (rendered with renderFace)
 *
 * The starting guess is roles.ts `suggestMapping` (through plan.ts
 * `startingTypes`: a card type the library already has starts from ITS
 * roles). Every edit is a pure function of src/domain/importFile.ts
 * (`setFrontField`, `setFilterField`, …). The sample is drawn with
 * `renderFace` and the card type `buildNoteType` makes, so it shows exactly
 * what the import will make.
 *
 * Every field (and every CSV column) is named by the ONE label rule of the
 * app, render.ts `fieldDisplayLabel` (`fieldName` below): its label, else its
 * name made readable, so this stage says the same words as the cards it
 * makes (wave 5d, R6).
 *
 * A CSV gets the same stage: every column is Front / Back / Example / Show on
 * back / Filter / Tags / Ignore, plus "First row is a header" and "Also make
 * a reverse card" (spec §5.9 — the mapping step the old copy promised).
 *
 * An Anki card type that the library already has (a re-import) keeps its own
 * fields (the planner reuses it, so a deck is never split over two card
 * types); only its directions can change here. A NEWER version of its model
 * that adds or removes fields (the German vocabulary deck: version 2 added
 * Type and Plural, version 3 removed MarankiExample) upgrades it: the line
 * names those fields, the other fields stay.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Btn, CardBox, Chip, Ion, Overline, Pill, RiseIn, Sheet, Toggle } from '@/components/ui';
import {
  buildNoteType,
  cardOrdsByNote,
  chosenNotesByMid,
  findReusableType,
  type TypeStart,
} from '@/domain/import/plan';
import {
  choiceTypes,
  CSV_COLUMN_ROLES,
  csvColumnRole,
  csvFieldColumns,
  csvTagsLabel,
  directionName,
  isFilterOn,
  reusedTypeLine,
  setBackField,
  setCsvColumnRole,
  setExampleField,
  setFieldLang,
  setFilterField,
  setFrontField,
  setShownOnBack,
  type CsvColumnRole,
} from '@/domain/importFile';
import { COMMON_LANGS, langLabel, mergeLangs } from '@/domain/lang/bcp47';
import type { AnkiCollection, CardFace, FieldBlock, FieldDef, Note, NoteType } from '@/domain/model';
import { fieldDisplayLabel, renderFace } from '@/domain/render';
import type { TypeDraft } from '@/domain/roles';
import { plural } from '@/domain/text';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** One source card type on the Fields stage: where it started, and the guess it came from. */
export interface TypeEdit extends TypeStart {
  /** roles.ts's guess (name, kind, fill %, distinct values, the suggested roles). */
  draft: TypeDraft;
  /** The fields offered as filters, and whether each passes the data rule (importFile.ts `filterCandidates`). */
  candidates: { index: number; passes: boolean }[];
}

/** The file-level CSV switches (re-reading the file is the screen's job). */
export interface CsvControls {
  header: boolean;
  onHeader: (on: boolean) => void;
  /** Make this FILE column the tags column; null = no tags column. */
  onTagsColumn: (column: number | null) => void;
}

interface FieldsStageProps {
  collection: AnkiCollection;
  /** The card types that have notes in the chosen sections. */
  edits: TypeEdit[];
  sections: ReadonlySet<string>;
  onEdit: (mid: string, next: { fields?: FieldDef[]; ords?: number[] }) => void;
  /** Set for a CSV (or an Anki text export). */
  csv: CsvControls | null;
  onContinue: () => void;
  onBack: () => void;
}

export function FieldsStage({ collection, edits, sections, onEdit, csv, onContinue, onBack }: FieldsStageProps) {
  const c = useColors();
  // The chosen notes per card type, and the card ords of every note (for the sample).
  const notesByMid = useMemo(() => chosenNotesByMid(collection, sections), [collection, sections]);
  const ordsByNote = useMemo(() => cardOrdsByNote(collection), [collection]);

  return (
    <RiseIn duration={250}>
      <Overline style={{ marginBottom: 10 }}>Choose fields — nothing imported yet</Overline>
      {csv ? (
        <CardBox style={{ marginBottom: 12 }}>
          <SwitchRow label="First row is a header" on={csv.header} onChange={csv.onHeader} />
          {csvTagsLabel(collection) ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <Text style={[font('sans', 400), { flex: 1, fontSize: 13.5, color: c.ink2 }]}>{csvTagsLabel(collection)}</Text>
              <Btn kind="quiet" size="sm" onPress={() => csv.onTagsColumn(null)}>
                Not tags
              </Btn>
            </View>
          ) : null}
        </CardBox>
      ) : null}
      {edits.map((edit) => (
        <TypeCard
          key={edit.mid}
          collection={collection}
          edit={edit}
          notes={notesByMid.get(edit.mid) ?? []}
          ordsByNote={ordsByNote}
          csv={csv}
          onEdit={(next) => onEdit(edit.mid, next)}
        />
      ))}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
        <Btn kind="secondary" full style={{ flex: 1 }} onPress={onBack}>
          Back
        </Btn>
        <Btn full style={{ flex: 1 }} icon="arrow-forward" onPress={onContinue}>
          Continue
        </Btn>
      </View>
    </RiseIn>
  );
}

/* ---------------------------------------------------------------- one card type */

type PickerKind = 'front' | 'back' | 'langFront' | 'langBack';

/** The read-aloud languages a picker offers: the device voice, then the common languages by name. */
const LANG_OPTIONS = mergeLangs(COMMON_LANGS);

const pct = (share: number) => `${Math.round(share * 100)}% filled`;
/**
 * The name a field shows on this stage: the ONE label rule of the app
 * (render.ts `fieldDisplayLabel`): its label, else its name made readable —
 * the same words the imported cards will show ("MarankiExample" → "Example",
 * "VerbForms" → "Verb Forms"; wave 5d, R6). '—' for no field.
 */
const fieldName = (f: FieldDef | undefined) => (f ? fieldDisplayLabel(f) : '—');

function TypeCard({
  collection,
  edit,
  notes,
  ordsByNote,
  csv,
  onEdit,
}: {
  collection: AnkiCollection;
  edit: TypeEdit;
  notes: AnkiCollection['notes'];
  ordsByNote: ReadonlyMap<string, number[]>;
  csv: CsvControls | null;
  onEdit: (next: { fields?: FieldDef[]; ords?: number[] }) => void;
}) {
  const c = useColors();
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const { draft, fields, ords } = edit;
  const isCloze = draft.kind === 'cloze';
  // An Anki card type the library has: the planner keeps its roles.
  const lockedRoles = edit.reused !== null && csv === null;

  // The card type the import will make (or reuse), for the directions and the sample.
  const type = useMemo((): NoteType | null => {
    if (lockedRoles && edit.reused) return edit.reused;
    const choice = choiceTypes(collection, [edit])[edit.mid];
    if (edit.reused) {
      const same = findReusableType(collection, edit.mid, [edit.reused], choice);
      if (same) return same;
    }
    return buildNoteType(collection, edit.mid, choice, `preview-${edit.mid}`, 0);
  }, [collection, edit, lockedRoles]);

  const term = fields.findIndex((f) => f.role === 'term');
  const meaning = fields.findIndex((f) => f.role === 'meaning');
  const examples = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.role === 'example')
    .sort((a, b) => (draft.fill[b.i] ?? 0) - (draft.fill[a.i] ?? 0));
  const backRows = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.role === 'detail' || f.role === 'hidden' || f.role === 'pronunciation' || f.role === 'exampleMeaning');
  const setFields = (next: FieldDef[]) => onEdit({ fields: next });
  const toggleOrd = (ord: number) => {
    const on = ords.includes(ord);
    if (on && ords.length === 1) return; // at least one direction stays on
    onEdit({ ords: on ? ords.filter((o) => o !== ord) : [...ords, ord].sort((a, b) => a - b) });
  };

  const pickerOptions: { id: string; label: string; sub?: string }[] =
    picker === 'front' || picker === 'back'
      ? fields.map((f, i) => ({ id: String(i), label: fieldName(f), sub: pct(draft.fill[i] ?? 0) }))
      : [{ id: '', label: 'Device voice' }, ...LANG_OPTIONS.map((tag) => ({ id: tag, label: langLabel(tag) }))];
  const pickerValue =
    picker === 'front'
      ? String(term)
      : picker === 'back'
        ? String(meaning)
        : picker === 'langFront'
          ? (fields[term]?.lang ?? '')
          : (fields[meaning]?.lang ?? '');
  const onPick = (id: string) => {
    if (picker === 'front') setFields(setFrontField(fields, Number(id)));
    else if (picker === 'back') setFields(setBackField(fields, Number(id)));
    else if (picker === 'langFront' && term >= 0) setFields(setFieldLang(fields, term, id || null));
    else if (picker === 'langBack' && meaning >= 0) setFields(setFieldLang(fields, meaning, id || null));
    setPicker(null);
  };

  return (
    <CardBox style={{ marginBottom: 12 }}>
      <Text style={[font('serif', 600), tnum, { fontSize: 18, color: c.ink, marginBottom: 10 }]}>
        {`${draft.name || 'Cards'} · ${plural(notes.length, 'item')}`}
      </Text>

      {lockedRoles && edit.reused ? (
        <Text style={[font('sans', 400), { fontSize: 13, lineHeight: 19, color: c.ink2, marginBottom: 8 }]}>
          {reusedTypeLine(edit.reused, edit.addedFields, edit.removedFields)}
        </Text>
      ) : csv ? (
        <CsvColumns collection={collection} edit={edit} onFields={setFields} onTagsColumn={csv.onTagsColumn} />
      ) : (
        <>
          <PickRow label="Front" value={fieldName(fields[term])} onPress={() => setPicker('front')} />
          {!isCloze ? <PickRow label="Back" value={fieldName(fields[meaning])} onPress={() => setPicker('back')} /> : null}
          <Line label="Examples">
            <View style={{ flex: 1 }}>
              <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink }]}>
                {examples.length > 0
                  ? examples.map(({ f, i }) => `${fieldName(f)} (${pct(draft.fill[i] ?? 0)})`).join(' · ')
                  : 'none'}
              </Text>
              {examplesOpen
                ? fields.map((f, i) =>
                    f.role === 'term' || f.role === 'meaning' || f.role === 'badge' ? null : (
                      <Check
                        key={f.name}
                        on={f.role === 'example'}
                        label={`${fieldName(f)} (${pct(draft.fill[i] ?? 0)})`}
                        onPress={() => setFields(setExampleField(fields, i, f.role !== 'example'))}
                      />
                    ),
                  )
                : null}
            </View>
            <Pressable onPress={() => setExamplesOpen((v) => !v)} hitSlop={8} accessibilityRole="button">
              <Text style={[font('sans', 700), { fontSize: 13, color: c.pine }]}>{examplesOpen ? 'Done' : 'Change'}</Text>
            </Pressable>
          </Line>
          {backRows.length > 0 ? (
            <Line label="Shown on back">
              <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 }}>
                {backRows.map(({ f, i }) => (
                  <Check
                    key={f.name}
                    on={f.role !== 'hidden'}
                    label={fieldName(f)}
                    onPress={() => setFields(setShownOnBack(fields, i, f.role === 'hidden', draft.fields[i]?.role))}
                  />
                ))}
              </View>
            </Line>
          ) : null}
        </>
      )}

      {!lockedRoles && edit.candidates.length > 0 ? (
        <Line label="Filters">
          <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 }}>
            {edit.candidates.map(({ index: i, passes }) => {
              const f = fields[i];
              if (!f) return null;
              return (
                <Check
                  key={f.name}
                  on={isFilterOn(f)}
                  label={`${fieldName(f)} (${plural(draft.distinct[i] ?? 0, 'value')})`}
                  onPress={() => setFields(setFilterField(fields, i, !isFilterOn(f), passes))}
                />
              );
            })}
          </View>
        </Line>
      ) : null}

      {type ? (
        <Line label="Directions">
          {isCloze ? (
            <Text style={[font('sans', 400), { flex: 1, fontSize: 13.5, color: c.ink }]}>One card per cloze number</Text>
          ) : csv ? (
            <View style={{ flex: 1 }}>
              <Check on label={directionName(type, 0)} onPress={() => undefined} disabled />
              {fields.length > 1 ? (
                <Check on={ords.includes(1)} label="Also make a reverse card" onPress={() => toggleOrd(1)} />
              ) : null}
            </View>
          ) : (
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 }}>
              {type.templates.map((t) => (
                <Check key={t.ord} on={ords.includes(t.ord)} label={directionName(type, t.ord)} onPress={() => toggleOrd(t.ord)} />
              ))}
            </View>
          )}
        </Line>
      ) : null}

      {!lockedRoles && term >= 0 ? (
        <Line label="Read aloud">
          <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip onPress={() => setPicker('langFront')}>{`Front: ${langOrDevice(fields[term]?.lang)} ▾`}</Chip>
            {meaning >= 0 ? (
              <Chip onPress={() => setPicker('langBack')}>{`Back: ${langOrDevice(fields[meaning]?.lang)} ▾`}</Chip>
            ) : null}
          </View>
        </Line>
      ) : null}

      {type && notes.length > 0 ? <Sample type={type} notes={notes} ords={ords} ordsByNote={ordsByNote} /> : null}

      <Sheet
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={picker === 'front' ? 'Front' : picker === 'back' ? 'Back' : 'Read aloud'}
      >
        <ScrollView style={{ maxHeight: 420 }}>
          {pickerOptions.map((o, i) => (
            <Pressable
              key={o.id || 'device'}
              onPress={() => onPick(o.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: o.id === pickerValue }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 12,
                borderBottomWidth: i < pickerOptions.length - 1 ? 1 : 0,
                borderBottomColor: c.hairlineSoft,
              }}
            >
              <Text numberOfLines={1} style={[font('sans', 600), { flex: 1, fontSize: 15, color: c.ink }]}>
                {o.label}
              </Text>
              {o.sub ? <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3 }]}>{o.sub}</Text> : null}
              {o.id === pickerValue ? <Ion name="checkmark" size={18} color={c.pine} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
    </CardBox>
  );
}

/** "German", or "Device voice" when no language is set. */
function langOrDevice(tag: string | undefined): string {
  return tag ? langLabel(tag) : 'Device voice';
}

/* ---------------------------------------------------------------- CSV columns */

function CsvColumns({
  collection,
  edit,
  onFields,
  onTagsColumn,
}: {
  collection: AnkiCollection;
  edit: TypeEdit;
  onFields: (next: FieldDef[]) => void;
  onTagsColumn: (column: number | null) => void;
}) {
  const c = useColors();
  const columns = csvFieldColumns(collection, edit.fields.length);
  const pick = (i: number, role: CsvColumnRole) => {
    if (role === 'tags') {
      const column = columns[i];
      if (column !== undefined) onTagsColumn(column);
      return;
    }
    onFields(setCsvColumnRole(edit.fields, i, role));
  };
  return (
    <View style={{ marginBottom: 4 }}>
      {edit.fields.map((f, i) => {
        const current = csvColumnRole(f);
        return (
          <View key={f.name} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.hairlineSoft }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text numberOfLines={1} style={[font('sans', 700), { flex: 1, fontSize: 14, color: c.ink }]}>
                {fieldName(f)}
              </Text>
              <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3 }]}>{pct(edit.draft.fill[i] ?? 0)}</Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {CSV_COLUMN_ROLES.map((r) => (
                <Chip key={r.id} active={current === r.id} onPress={() => pick(i, r.id)}>
                  {r.label}
                </Chip>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/* ---------------------------------------------------------------- sample */

/** The text of a block, or "(image)" for a block that only shows a picture. */
function blockLabel(block: FieldBlock | undefined): string {
  if (!block) return '';
  if (block.plain.trim() !== '') return block.plain;
  return block.lines.some((line) => line.some((part) => part.t === 'img')) ? '(image)' : '';
}

/** One note of the file drawn as the card the import will make: "‹ 1 / 6,845 › die Abfahrt → departure". */
function Sample({
  type,
  notes,
  ords,
  ordsByNote,
}: {
  type: NoteType;
  notes: AnkiCollection['notes'];
  ords: number[];
  ordsByNote: ReadonlyMap<string, number[]>;
}) {
  const c = useColors();
  const [index, setIndex] = useState(0);
  const at = Math.min(index, notes.length - 1);
  const source = notes[at];

  const face = useMemo((): CardFace | null => {
    if (!source) return null;
    const note: Note = {
      id: `sample-${source.id}`,
      typeId: type.id,
      fields: type.fields.map((_, k) => source.flds[k] ?? ''),
      tags: [...source.tags],
      section: '',
      guid: source.guid,
      order: 0,
      source: { kind: 'apkg' },
      createdAt: 0,
      updatedAt: 0,
    };
    // The note's first card that the import makes: a cloze note's first card, or the first enabled direction.
    const have = ordsByNote.get(source.id) ?? [];
    const ord = type.kind === 'cloze' ? (have[0] ?? 0) : (have.find((o) => ords.includes(o)) ?? ords[0] ?? 0);
    return renderFace(note, type, ord);
  }, [source, type, ords, ordsByNote]);

  if (!face) return null;
  const rest = face.answer.slice(1).filter((b) => b.role !== 'hidden' && blockLabel(b) !== '');
  return (
    <View style={{ marginTop: 12, borderWidth: 1, borderColor: c.hairlineStrong, borderRadius: 12, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <Overline style={{ flex: 1 }}>Sample</Overline>
        <Pressable
          onPress={() => setIndex(Math.max(0, at - 1))}
          disabled={at === 0}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Previous sample"
          style={{ opacity: at === 0 ? 0.35 : 1 }}
        >
          <Ion name="chevron-back" size={16} color={c.ink2} />
        </Pressable>
        <Text style={[font('mono', 400), tnum, { fontSize: 12, color: c.ink3, marginHorizontal: 8 }]}>
          {`${(at + 1).toLocaleString('en-US')} / ${notes.length.toLocaleString('en-US')}`}
        </Text>
        <Pressable
          onPress={() => setIndex(Math.min(notes.length - 1, at + 1))}
          disabled={at >= notes.length - 1}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Next sample"
          style={{ opacity: at >= notes.length - 1 ? 0.35 : 1 }}
        >
          <Ion name="chevron-forward" size={16} color={c.ink2} />
        </Pressable>
      </View>
      {face.badges.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {face.badges.map((b) => (
            <Pill key={b.field}>{b.plain}</Pill>
          ))}
        </View>
      ) : null}
      <Text numberOfLines={3} style={[font('serif', 600), { fontSize: 17, color: c.ink }]}>
        {`${blockLabel(face.prompt[0]) || '(empty)'}  →  ${face.answerPlain || blockLabel(face.answer[0]) || '(empty)'}`}
      </Text>
      {rest.map((b) => (
        <Text key={b.field} numberOfLines={2} style={[font('sans', 400), { fontSize: 12.5, color: c.ink2, marginTop: 4 }]}>
          <Text style={[font('sans', 700), { color: c.ink3 }]}>{`${b.label.toUpperCase()}  `}</Text>
          {blockLabel(b)}
        </Text>
      ))}
    </View>
  );
}

/* ---------------------------------------------------------------- small parts */

/** A labelled line: "Front   [ Word ▾ ]". */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 }}>
      <Text style={[font('sans', 600), { width: 104, fontSize: 12.5, color: c.ink3, paddingTop: 2 }]}>{label}</Text>
      {children}
    </View>
  );
}

/** "Front [ Word ▾ ]": a field picker. */
function PickRow({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Line label={label}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}. Change`}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: c.hairlineStrong,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <Text numberOfLines={1} style={[font('sans', 600), { flex: 1, fontSize: 14, color: c.ink }]}>
          {value}
        </Text>
        <Ion name="chevron-down" size={15} color={c.ink3} />
      </Pressable>
    </Line>
  );
}

/** A check box with a label. */
function Check({
  on,
  label,
  onPress,
  disabled,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: !!disabled }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 }}
    >
      <Ion name={on ? 'checkbox' : 'square-outline'} size={18} color={on && !disabled ? c.pine : c.ink3} />
      <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink }]}>{label}</Text>
    </Pressable>
  );
}

/** A label with a switch. */
function SwitchRow({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Text style={[font('sans', 600), { flex: 1, fontSize: 14, color: c.ink }]}>{label}</Text>
      <Toggle on={on} onChange={onChange} label={label} />
    </View>
  );
}
