/**
 * ReadAloudSheet — the languages 🔊 uses for this deck (spec §6.8, §9.3):
 *
 *   CARDS YOU MAKE IN THE APP          (fallback for card types not from Anki)
 *   Front language     German          → deck.language
 *   Back language      English         → deck.meaningLanguage
 *   GERMAN VOCABULARY                  (one block per Anki card type)
 *   Word               German          → FieldDef.lang (updateNoteType)
 *   Translation        English
 *
 * WHY two parts: an Anki card type names its languages itself ({{tts}}), so
 * the deck languages never apply to it (render.ts resolveFieldLang). Its
 * fields are set one by one here. Card types made in the app or from a CSV
 * use the deck's front and back languages.
 *
 * A field row says the field's readable label (`fieldLabel`, the one label
 * rule of render.ts `fieldDisplayLabel`): "Example", never the internal name
 * "MarankiExample" (wave 5d, R6).
 *
 * Choosing a language swaps the sheet to a list (a second sheet on top of a
 * sheet is not reliable on every phone), with "Back" to return. The list is
 * the common languages plus the phone's voices (Speech.getAvailableVoicesAsync,
 * read once when the sheet opens; the answer comes in a promise callback,
 * never in the effect body).
 */
import * as Speech from 'expo-speech';
import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { Ion, ListRow, Overline, Row, Sheet } from '@/components/ui';
import { COMMON_LANGS, langLabel, mergeLangs } from '@/domain/lang/bcp47';
import type { Deck, Id, NoteType } from '@/domain/model';
import { fieldLabel } from '@/domain/fieldText';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { isAnkiType, isSpokenField } from './deckPageLogic';

/** What the language list is choosing for. */
type Target = { kind: 'deck'; side: 'front' | 'back' } | { kind: 'field'; typeId: Id; index: number };

interface ReadAloudSheetProps {
  open: boolean;
  onClose: () => void;
  deck: Deck;
  /** The deck's card types. */
  types: readonly NoteType[];
  /** Set the deck's front or back language (null = none). */
  onDeckLang: (side: 'front' | 'back', lang: string | null) => void;
  /** Set one field's language of an Anki card type (null = the device voice). */
  onFieldLang: (typeId: Id, fieldIndex: number, lang: string | null) => void;
}

export function ReadAloudSheet({ open, onClose, deck, types, onDeckLang, onFieldLang }: ReadAloudSheetProps) {
  const c = useColors();
  const [target, setTarget] = useState<Target | null>(null);
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

  const ankiTypes = types.filter(isAnkiType);
  const current = (t: Target): string => {
    if (t.kind === 'deck') return (t.side === 'front' ? deck.language : deck.meaningLanguage) ?? '';
    return types.find((x) => x.id === t.typeId)?.fields[t.index]?.lang ?? '';
  };
  const langs = useMemo(() => {
    // The languages already in use stay in the list, also when the phone has no voice for them.
    const known = [deck.language, deck.meaningLanguage, ...types.flatMap((t) => t.fields.map((f) => f.lang))].filter(
      (l): l is string => typeof l === 'string' && l !== '',
    );
    return mergeLangs(COMMON_LANGS, voiceLangs, known);
  }, [voiceLangs, deck.language, deck.meaningLanguage, types]);
  const shown = (lang: string | undefined, none: string) => (lang ? langLabel(lang) : none);

  const pick = (lang: string | null) => {
    if (!target) return;
    if (target.kind === 'deck') onDeckLang(target.side, lang);
    else onFieldLang(target.typeId, target.index, lang);
    setTarget(null);
  };

  return (
    <Sheet open={open} onClose={onClose} onClosed={() => setTarget(null)} title={target ? 'Choose a language' : 'Read aloud'}>
      {target ? (
        <View>
          <Row padV={12} onPress={() => setTarget(null)} label="Back">
            <Ion name="chevron-back" size={18} color={c.pine} />
            <Text style={[font('sans', 700), { flex: 1, fontSize: 14.5, color: c.pine }]}>Back</Text>
          </Row>
          {[{ tag: '', label: target.kind === 'deck' ? 'None' : 'Device voice' }, ...langs.map((tag) => ({ tag, label: langLabel(tag) }))].map(
            (r, i, all) => (
              <Row key={r.tag || 'none'} padV={12} last={i === all.length - 1} onPress={() => pick(r.tag || null)}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>
                    {r.label}
                  </Text>
                  {r.tag ? <Text style={[font('mono', 400), { fontSize: 12, color: c.ink3 }]}>{r.tag}</Text> : null}
                </View>
                {r.tag === current(target) ? <Ion name="checkmark" size={19} color={c.pine} /> : null}
              </Row>
            ),
          )}
        </View>
      ) : (
        <View>
          <Overline header style={{ marginBottom: 2 }}>
            Cards you make in the app
          </Overline>
          <ListRow
            icon="language-outline"
            title="Front language"
            sub={shown(deck.language, 'Not set')}
            onPress={() => setTarget({ kind: 'deck', side: 'front' })}
          />
          <ListRow
            icon="language-outline"
            title="Back language"
            sub={shown(deck.meaningLanguage, 'Not set')}
            onPress={() => setTarget({ kind: 'deck', side: 'back' })}
            last
          />
          <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 4 }]}>
            Also used for German noun genders. Cards from Anki use their own languages, below.
          </Text>

          {ankiTypes.map((type) => {
            const spoken = type.fields.map((f, i) => ({ f, i })).filter(({ f }) => isSpokenField(f));
            if (spoken.length === 0) return null;
            return (
              <View key={type.id} style={{ marginTop: 20 }}>
                <Overline header style={{ marginBottom: 2 }}>
                  {type.name}
                </Overline>
                {spoken.map(({ f, i }, k) => (
                  <ListRow
                    key={f.name}
                    icon="volume-medium-outline"
                    title={fieldLabel(f)}
                    sub={shown(f.lang, 'Device voice')}
                    last={k === spoken.length - 1}
                    onPress={() => setTarget({ kind: 'field', typeId: type.id, index: i })}
                  />
                ))}
              </View>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}
