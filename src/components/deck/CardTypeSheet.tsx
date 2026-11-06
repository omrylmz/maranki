/**
 * CardTypeSheet — "Card types & fields" of the deck page (spec §8.2). It
 * fixes a wrong import guess: fields are never thrown away, only shown in
 * another way.
 *
 *   ( German Vocabulary | German Verbs )          ← only when the deck has 2+ card types
 *   Word            Headline · Filter: Off · German          ›
 *   Translation     Answer · Filter: Off · English           ›
 *   Level           Badge · Filter: Auto                     ›
 *   SAMPLE   die Abfahrt → departure   (drawn with the draft)
 *   Also used in 1 other deck. Changes apply there too.
 *   [ Save ]
 *
 * Every field is named by `fieldLabel` (src/domain/fieldText.ts = render.ts
 * `fieldDisplayLabel`, the one label rule of the app): its own label, else
 * its name made readable — "MarankiExample" reads "Example", "VerbForms"
 * reads "Verb Forms", the same words as on the cards (wave 5d, R6). Only the
 * field editor's small line `Field “MarankiExample”` shows the real name.
 *
 * A field row opens its editor inside the sheet (a second sheet on top of a
 * sheet is not reliable): Label (editable; empty = the readable name), Role
 * (Headline · Answer · Example · Example meaning · Pronunciation · Detail ·
 * Badge · Hidden), Filter (Auto / On / Off) and Read aloud (a language, or
 * the device voice).
 *
 * The changes are a DRAFT until "Save", which calls `updateNoteType` once
 * (the page passes `onSave`). The sample card is rendered from the draft with
 * renderFace, so it shows exactly what Save will do.
 *
 * The label box keeps the text exactly as it is typed (deckPageLogic.ts
 * `patchFieldDef`); the clean-up (trim; an empty label or the field name
 * itself → no label) runs once, on the whole draft, with `normalizeFields`
 * — for the sample, the Save button and the saved fields.
 */
import * as Speech from 'expo-speech';
import React, { useEffect, useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Btn, CardBox, Chip, FieldRows, Ion, ListRow, Overline, Row, SegCtrl, Sheet } from '@/components/ui';
import { blocksAfterHeadline } from '@/domain/face';
import { fieldLabel } from '@/domain/fieldText';
import { COMMON_LANGS, langLabel, mergeLangs } from '@/domain/lang/bcp47';
import type { Deck, FieldDef, Id, Note, NoteType } from '@/domain/model';
import { renderFace } from '@/domain/render';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { FILTER_OPTIONS, fieldsChanged, normalizeFields, patchFieldDef, ROLE_OPTIONS, sharedTypeNote } from './deckPageLogic';

/** The panel the sheet shows: the field list, one field's editor, or a language list. */
type Panel = { kind: 'list' } | { kind: 'field'; index: number } | { kind: 'lang'; index: number };

interface CardTypeSheetProps {
  open: boolean;
  onClose: () => void;
  deck: Deck;
  /** The deck's card types. */
  types: readonly NoteType[];
  /** A note of each card type in this deck, for the sample (typeId → note). */
  samples: ReadonlyMap<Id, Note>;
  /** How many OTHER decks use each card type (typeId → count). */
  otherDecks: ReadonlyMap<Id, number>;
  onSave: (typeId: Id, fields: FieldDef[]) => void;
}

const ROLE_LABEL = new Map(ROLE_OPTIONS.map((r) => [r.id, r.label]));
const FILTER_LABEL = new Map(FILTER_OPTIONS.map((f) => [f.id, f.label]));

/** "Headline · Filter: Auto · German" — the summary under a field row. */
function fieldSummary(f: FieldDef): string {
  const parts = [ROLE_LABEL.get(f.role) ?? f.role, `Filter: ${FILTER_LABEL.get(f.facet) ?? f.facet}`];
  if (f.lang) parts.push(langLabel(f.lang));
  return parts.join(' · ');
}

export function CardTypeSheet({ open, onClose, deck, types, samples, otherDecks, onSave }: CardTypeSheetProps) {
  const c = useColors();
  const [typeId, setTypeId] = useState<Id | null>(types[0]?.id ?? null);
  const type = types.find((t) => t.id === typeId) ?? types[0] ?? null;
  // The draft: a copy of the stored fields. It starts again when another
  // card type is shown or the stored card type changes (adjust state during
  // render, no effect).
  const [base, setBase] = useState<NoteType | null>(type);
  const [draft, setDraft] = useState<FieldDef[]>(() => (type ? type.fields.map((f) => ({ ...f })) : []));
  if (type !== base) {
    setBase(type);
    setDraft(type ? type.fields.map((f) => ({ ...f })) : []);
  }
  const [panel, setPanel] = useState<Panel>({ kind: 'list' });
  const [voiceLangs, setVoiceLangs] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    Speech.getAvailableVoicesAsync()
      .then((voices) => {
        if (alive) setVoiceLangs(voices.map((v) => v.language));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);
  const langs = useMemo(
    () => mergeLangs(COMMON_LANGS, voiceLangs, draft.map((f) => f.lang ?? '').filter((l) => l !== '')),
    [voiceLangs, draft],
  );

  // The sample: the first card direction of a real note, drawn with the draft fields.
  const sample = useMemo(() => {
    if (!type) return null;
    const note = samples.get(type.id);
    if (!note) return null;
    const ord = type.templates[0]?.ord ?? 0;
    return renderFace(note, { ...type, fields: normalizeFields(draft) }, ord, deck);
  }, [type, samples, draft, deck]);

  const changed = type ? fieldsChanged(type.fields, draft) : false;
  const patch = (i: number, p: Parameters<typeof patchFieldDef>[2]) => setDraft((d) => patchFieldDef(d, i, p));

  const close = () => {
    setPanel({ kind: 'list' });
    onClose();
  };

  const title = panel.kind === 'list' ? 'Card types & fields' : panel.kind === 'field' ? fieldLabel(draft[panel.index]) : 'Read aloud';

  return (
    <Sheet
      open={open}
      onClose={close}
      onClosed={() => {
        setPanel({ kind: 'list' });
        if (type) setDraft(type.fields.map((f) => ({ ...f })));
      }}
      title={title}
    >
      {!type ? (
        <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2 }]}>This deck has no cards yet.</Text>
      ) : panel.kind === 'list' ? (
        <View>
          {types.length > 1 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {types.map((t) => (
                <Chip
                  key={t.id}
                  active={t.id === type.id}
                  onPress={() => {
                    if (t.id === type.id) return;
                    setTypeId(t.id);
                  }}
                >
                  {t.name}
                </Chip>
              ))}
            </View>
          ) : (
            <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2, marginBottom: 4 }]}>{type.name}</Text>
          )}
          {draft.map((f, i) => (
            <ListRow
              key={f.name}
              title={fieldLabel(f)}
              sub={fieldSummary(f)}
              last={i === draft.length - 1}
              onPress={() => setPanel({ kind: 'field', index: i })}
            />
          ))}

          {sample ? (
            <CardBox style={{ marginTop: 14 }}>
              <Overline style={{ marginBottom: 8 }}>Sample</Overline>
              <Text style={[font('serif', 600), { fontSize: 22, lineHeight: 27, color: c.ink }]}>{sample.promptPlain || '—'}</Text>
              <View style={{ height: 1, backgroundColor: c.hairlineSoft, marginVertical: 10 }} />
              <Text style={[font('serif', 600), { fontSize: 18, lineHeight: 23, color: c.ink }]}>{sample.answerPlain || '—'}</Text>
              <FieldRows blocks={blocksAfterHeadline(sample.answer)} variant="compact" style={{ marginTop: 8 }} />
            </CardBox>
          ) : null}

          {sharedTypeNote(otherDecks.get(type.id) ?? 0) ? (
            <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 12 }]}>
              {sharedTypeNote(otherDecks.get(type.id) ?? 0)}
            </Text>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Btn kind="secondary" full style={{ flex: 1 }} onPress={close}>
              {changed ? 'Cancel' : 'Close'}
            </Btn>
            <Btn
              full
              style={{ flex: 1 }}
              disabled={!changed}
              onPress={() => {
                onSave(type.id, normalizeFields(draft));
                close();
              }}
            >
              Save
            </Btn>
          </View>
        </View>
      ) : panel.kind === 'field' ? (
        <FieldEditor
          field={draft[panel.index]}
          onLabel={(label) => patch(panel.index, { label })}
          onRole={(role) => patch(panel.index, { role })}
          onFilter={(facet) => patch(panel.index, { facet })}
          onLanguage={() => setPanel({ kind: 'lang', index: panel.index })}
          onDone={() => setPanel({ kind: 'list' })}
        />
      ) : (
        <View>
          <Row padV={12} onPress={() => setPanel({ kind: 'field', index: panel.index })} label="Back">
            <Ion name="chevron-back" size={18} color={c.pine} />
            <Text style={[font('sans', 700), { flex: 1, fontSize: 14.5, color: c.pine }]}>Back</Text>
          </Row>
          {[{ tag: '', label: 'Device voice' }, ...langs.map((tag) => ({ tag, label: langLabel(tag) }))].map((r, i, all) => (
            <Row
              key={r.tag || 'none'}
              padV={12}
              last={i === all.length - 1}
              onPress={() => {
                patch(panel.index, { lang: r.tag || undefined });
                setPanel({ kind: 'field', index: panel.index });
              }}
            >
              <Text numberOfLines={1} style={[font('sans', 700), { flex: 1, fontSize: 15, color: c.ink }]}>
                {r.label}
              </Text>
              {(draft[panel.index]?.lang ?? '') === r.tag ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
            </Row>
          ))}
        </View>
      )}
    </Sheet>
  );
}

/** One field's editor: label, role, filter, read aloud. */
function FieldEditor({
  field,
  onLabel,
  onRole,
  onFilter,
  onLanguage,
  onDone,
}: {
  field: FieldDef;
  onLabel: (label: string) => void;
  onRole: (role: FieldDef['role']) => void;
  onFilter: (facet: FieldDef['facet']) => void;
  onLanguage: () => void;
  onDone: () => void;
}) {
  const c = useColors();
  return (
    <View>
      <Text style={[font('mono', 400), { fontSize: 12, color: c.ink3, marginBottom: 10 }]}>{`Field “${field.name}”`}</Text>
      <Overline style={{ marginBottom: 7 }}>Label</Overline>
      <TextInput
        value={field.label ?? ''}
        onChangeText={onLabel}
        // An empty label shows the field's name made readable (fieldLabel): the words the cards show.
        placeholder={fieldLabel({ name: field.name })}
        placeholderTextColor={c.ink3}
        accessibilityLabel="Label"
        style={[
          font('sans', 400),
          {
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: c.hairlineStrong,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 11,
            fontSize: 15.5,
            color: c.ink,
            marginBottom: 16,
          },
        ]}
      />
      <Overline style={{ marginBottom: 7 }}>Role</Overline>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 12, marginBottom: 16 }}>
        {ROLE_OPTIONS.map((r) => (
          <Chip key={r.id} active={field.role === r.id} onPress={() => onRole(r.id)}>
            {r.label}
          </Chip>
        ))}
      </View>
      <Overline style={{ marginBottom: 7 }}>Filter</Overline>
      <SegCtrl
        size="sm"
        label="Filter"
        value={field.facet}
        onChange={(id) => onFilter(id === 'on' || id === 'off' ? id : 'auto')}
        options={FILTER_OPTIONS.map((f) => ({ id: f.id, label: f.label }))}
      />
      <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 6, marginBottom: 8 }]}>
        Auto makes it a filter when its values repeat (like a level). On always, Off never.
      </Text>
      <ListRow
        icon="volume-high-outline"
        title="Read aloud"
        sub={field.lang ? langLabel(field.lang) : 'Device voice'}
        onPress={onLanguage}
        last
      />
      <Btn full style={{ marginTop: 14 }} onPress={onDone}>
        Done
      </Btn>
    </View>
  );
}
