/**
 * Import wizard — the "Choose sections" stage (spec §5.4, §5.9).
 *
 * Shown only when the file (an .apkg from a file OR from AnkiWeb, or a CSV
 * with a deck column) has more than one subdeck. The learner picks which
 * subdecks to import; nothing is imported yet. The chosen subdecks are kept
 * as data: their common "::" part becomes the deck name and the rest each
 * note's section (the planner does that, src/domain/import/plan.ts).
 *
 * The tree comes from the pure `sectionTree` (src/domain/importFile.ts):
 * category headers with level rows ("Verbs" → A1, B1 …), or one flat row
 * per subdeck. A header row toggles all its levels at once.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, CardBox, Ion, Overline, RiseIn, Row } from '@/components/ui';
import type { CollectionSection } from '@/domain/import/plan';
import { sectionsFooter, sectionTree } from '@/domain/importFile';
import { plural } from '@/domain/text';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface SectionsStageProps {
  /** The file's deck name, shown as the title. */
  name: string;
  sections: CollectionSection[];
  /** The chosen subdeck ids (Anki deck ids; '' = notes without a known subdeck). */
  selected: ReadonlySet<string>;
  onSelected: (next: Set<string>) => void;
  onContinue: () => void;
  onCancel: () => void;
}

export function SectionsStage({ name, sections, selected, onSelected, onContinue, onCancel }: SectionsStageProps) {
  const c = useColors();
  const tree = sectionTree(sections);
  const allDids = sections.map((s) => s.did);
  const allOn = allDids.length > 0 && allDids.every((d) => selected.has(d));
  const chosen = sections.filter((s) => selected.has(s.did));

  /** Turn every id in `dids` on, or (when all are on already) off. */
  const toggle = (dids: string[]) => {
    const next = new Set(selected);
    const on = dids.every((d) => next.has(d));
    for (const d of dids) {
      if (on) next.delete(d);
      else next.add(d);
    }
    onSelected(next);
  };

  const leafRow = (leaf: { did: string; label: string; cards: number }, last: boolean, nested: boolean) => {
    const on = selected.has(leaf.did);
    return (
      <Pressable
        key={leaf.did}
        onPress={() => toggle([leaf.did])}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={`${leaf.label}, ${plural(leaf.cards, 'card')}`}
      >
        <Row padV={nested ? 11 : 13} last={last} style={{ paddingLeft: nested ? 40 : 16, paddingRight: 16 }}>
          <Ion name={on ? 'checkbox' : 'square-outline'} size={nested ? 20 : 22} color={on ? c.pine : c.ink3} />
          <Text
            numberOfLines={1}
            style={[font('sans', nested ? 400 : 700), { flex: 1, fontSize: nested ? 14 : 14.5, color: nested ? c.ink2 : c.ink }]}
          >
            {leaf.label}
          </Text>
          <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
            {leaf.cards.toLocaleString('en-US')}
          </Text>
        </Row>
      </Pressable>
    );
  };

  return (
    <RiseIn duration={250}>
      <Overline style={{ marginBottom: 10 }}>Choose sections — nothing imported yet</Overline>
      <Text style={[font('serif', 600), { fontSize: 20, color: c.ink, marginBottom: 4 }]}>{name}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <Text style={[font('sans', 400), tnum, { fontSize: 13, color: c.ink3 }]}>{plural(sections.length, 'section')}</Text>
        <Pressable onPress={() => onSelected(allOn ? new Set() : new Set(allDids))} hitSlop={8} accessibilityRole="button">
          <Text style={[font('sans', 700), { fontSize: 13.5, color: c.pine }]}>{allOn ? 'Clear all' : 'Select all'}</Text>
        </Pressable>
      </View>

      {tree.mode === 'grouped' ? (
        tree.groups.map((g) => {
          const dids = g.leaves.map((l) => l.did);
          const groupAll = dids.every((d) => selected.has(d));
          const groupSome = dids.some((d) => selected.has(d));
          return (
            <CardBox key={g.key} pad={0} style={{ marginBottom: 12 }}>
              <Pressable
                onPress={() => toggle(dids)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: groupAll ? true : groupSome ? 'mixed' : false }}
                accessibilityLabel={`${g.key}, ${plural(g.cards, 'card')}`}
              >
                <Row padV={13} style={{ paddingHorizontal: 16 }}>
                  <Ion
                    name={groupAll ? 'checkbox' : groupSome ? 'remove-circle' : 'square-outline'}
                    size={22}
                    color={groupAll || groupSome ? c.pine : c.ink3}
                  />
                  <Text style={[font('sans', 700), { flex: 1, fontSize: 14.5, color: c.ink }]}>{g.key}</Text>
                  <Text style={[font('mono', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
                    {g.cards.toLocaleString('en-US')}
                  </Text>
                </Row>
              </Pressable>
              {g.leaves.map((leaf, i) => leafRow(leaf, i === g.leaves.length - 1, true))}
            </CardBox>
          );
        })
      ) : (
        <CardBox pad={0}>{tree.leaves.map((leaf, i) => leafRow(leaf, i === tree.leaves.length - 1, false))}</CardBox>
      )}

      <Text
        style={[
          font('sans', 400),
          tnum,
          { fontSize: 12.5, color: c.ink3, marginTop: 14, marginBottom: 12, marginHorizontal: 2 },
        ]}
      >
        {sectionsFooter(chosen)}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn kind="secondary" full style={{ flex: 1 }} onPress={onCancel}>
          Cancel
        </Btn>
        <Btn full style={{ flex: 1 }} icon="arrow-forward" disabled={chosen.length === 0} onPress={onContinue}>
          Continue
        </Btn>
      </View>
    </RiseIn>
  );
}
