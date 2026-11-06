/**
 * Import wizard — the "Preview" stage (spec §5.6, §5.8, §5.9). Nothing is
 * imported yet.
 *
 * EVERY number here comes from `plan.summary`: the planner
 * (src/domain/import/plan.ts) counts it from the very plan the Import button
 * applies. The lines and their words are built by pure helpers in
 * src/domain/importFile.ts (`previewHeadline`, `previewRows`, …), so they are
 * unit-tested. Field names are made readable first (`readableSummary`):
 * "Filters found: Level, Verb Forms", never "VerbForms" (wave 5d, R6).
 *
 *   Deck name   [ German ]  icon 🇩🇪          Import into ( New deck ) ( Existing deck ▾ )
 *   15,960 cards from 8,433 items · 15 sections
 *   (4,000 items will be updated in German)      ← only when the import adds AND updates (wave 5g)
 *   Filters found · Already in this deck · Already in other decks [Update them where they are]
 *   Study progress in this file [☑ Keep my Anki progress] · Suspended in Anki · Images · Audio
 *                                 (Images: "57 — already here" when nothing new is copied, wave 5i)
 *   HOW SHOULD NEW CARDS START?   (only with the triage screen, > 200 new cards)
 *   WHERE DO YOU START?           (only with the triage screen, an ordinal group)
 *   [ Import 15,960 cards ]
 *
 * TRIAGE_READY: "Let me choose what to learn" and "Where do you start?"
 * make cards that start Not started. Only the triage screen
 * (src/app/triage.tsx) can bring them into the queue, so in wave 3 (before
 * it existed) both blocks were hidden and every new card was queued: a
 * wave-3 build never stranded Not started cards. Unit W4-3 built the triage
 * screen and flipped this constant to true.
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, CardBox, Chip, Field, Ion, Overline, RiseIn, SegCtrl, Sheet, Toggle } from '@/components/ui';
import { fieldShownName } from '@/domain/facets';
import {
  canImport,
  ELSEWHERE_OPTIONS,
  importButtonLabel,
  imagesQuestion,
  newCardsOptions,
  overlapSkipLabel,
  overlapText,
  previewHeadline,
  previewRows,
  previewUpdateLine,
  renamedNotice,
  showNewCardsBlock,
  showPlacementBlock,
  type ImportPrefs,
} from '@/domain/importFile';
import type { Id, ImportSummary } from '@/domain/model';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** True: src/app/triage.tsx exists (unit W4-3). See the file header. */
export const TRIAGE_READY = true;

/**
 * The summary as the Preview shows it: every FIELD name made readable, the
 * way the Library's filter chips will say it (facets.ts `fieldShownName`:
 * a label someone chose stays as it is; else render.ts `humanizeFieldName`,
 * the one label rule of the app). So "Filters found" and "Where do you
 * start?" never show an internal name: "VerbForms" reads "Verb Forms",
 * "MarankiExample" reads "Example" (wave 5d, R6).
 *
 * Only the TEXT changes: a placement group is still chosen by its `facet`
 * key, and every number stays. The planner's own summary is not changed (a
 * new object comes back). PURE.
 *
 *   readableSummary({ filtersFound: ['Level', 'VerbForms'], … }).filtersFound → ['Level', 'Verb Forms']
 */
export function readableSummary(summary: ImportSummary): ImportSummary {
  return {
    ...summary,
    filtersFound: summary.filtersFound.map((label) => fieldShownName(label)),
    placementGroups: summary.placementGroups.map((group) => ({ ...group, label: fieldShownName(group.label) })),
  };
}

/** The deck icons offered for a new deck (the deck editor's set). */
const ICONS = ['🗂️', '📚', '🧠', '🔤', '🧮', '🌍', '🎯', '🎓', '⭐'];

interface PreviewStageProps {
  summary: ImportSummary;
  prefs: ImportPrefs;
  /** True for an Anki file (progress, suspension, images and audio exist only there). */
  anki: boolean;
  /** The library's decks, for "Existing deck". */
  decks: readonly { id: Id; name: string; icon: string }[];
  /** settings.srs.dailyNewLimit, for "10 new a day, in deck order". */
  dailyNewLimit: number;
  /** "Fields: Front → front, Back → back" when the Fields stage was skipped (certain guess); '' = none. */
  fieldsLine: string;
  /**
   * How many of the plan's image files the deck folders already hold, byte
   * for byte (importFile.ts `importImagesHere`, wave 5i). All of them →
   * "Images: 57 — already here". Leave it out when it is not known.
   */
  imagesHere?: number;
  onChangeFields: () => void;
  onPrefs: (patch: Partial<ImportPrefs>) => void;
  onImport: () => void;
  onCancel: () => void;
  /** Leave the screen (when there is nothing to import). */
  onClose: () => void;
}

export function PreviewStage({
  summary: planned,
  prefs,
  anki,
  decks,
  dailyNewLimit,
  fieldsLine,
  imagesHere = 0,
  onChangeFields,
  onPrefs,
  onImport,
  onCancel,
  onClose,
}: PreviewStageProps) {
  const c = useColors();
  const [deckSheet, setDeckSheet] = useState(false);
  // The planner's summary with readable field names (the numbers are the same).
  const summary = readableSummary(planned);
  const existing = decks.find((d) => d.id === prefs.existingDeckId) ?? null;
  const intoExisting = prefs.targetKind === 'existing' && existing !== null;
  // "Images: 57 — already here" when every planned picture is in its folder already (wave 5i).
  const rows = previewRows(summary, { anki, images: prefs.images, imagesHere });
  // "4,000 items will be updated in German Vocabulary" when the import also adds cards (wave 5g, E8).
  const updateLine = previewUpdateLine(summary);
  const renamed = renamedNotice(summary);
  const askImages = imagesQuestion(summary);
  const live = canImport(summary);
  const icons = ICONS.includes(prefs.deckIcon) ? ICONS : [prefs.deckIcon, ...ICONS];

  return (
    <RiseIn duration={250}>
      <Overline style={{ marginBottom: 10 }}>Preview — nothing imported yet</Overline>

      {/* ---- where the cards go */}
      <CardBox style={{ marginBottom: 12 }}>
        {decks.length > 0 ? (
          <View style={{ marginBottom: 14 }}>
            <Overline style={{ marginBottom: 7 }}>Import into</Overline>
            <SegCtrl
              size="sm"
              label="Import into"
              value={intoExisting ? 'existing' : 'new'}
              onChange={(id) => onPrefs({ targetKind: id === 'existing' ? 'existing' : 'new' })}
              options={[
                { id: 'new', label: 'New deck' },
                { id: 'existing', label: 'Existing deck' },
              ]}
            />
          </View>
        ) : null}
        {intoExisting ? (
          <Pressable
            onPress={() => setDeckSheet(true)}
            accessibilityRole="button"
            accessibilityLabel={`Existing deck: ${existing.name}. Change`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              borderWidth: 1,
              borderColor: c.hairlineStrong,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
          >
            <Text style={{ fontSize: 18 }}>{existing.icon}</Text>
            <Text numberOfLines={1} style={[font('sans', 700), { flex: 1, fontSize: 15, color: c.ink }]}>
              {existing.name}
            </Text>
            <Ion name="chevron-down" size={16} color={c.ink3} />
          </Pressable>
        ) : (
          <>
            <Field label="Deck name" value={prefs.deckName} onChange={(v) => onPrefs({ deckName: v })} />
            <Overline style={{ marginBottom: 7 }}>Icon</Overline>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {icons.map((icon) => (
                <Chip key={icon} active={prefs.deckIcon === icon} onPress={() => onPrefs({ deckIcon: icon })}>
                  {icon}
                </Chip>
              ))}
            </View>
          </>
        )}
      </CardBox>

      {/* ---- what is in the file, counted by the planner */}
      <CardBox>
        <Text style={[font('serif', 600), tnum, { fontSize: 19, color: c.ink, marginBottom: updateLine ? 4 : 10 }]}>
          {previewHeadline(summary)}
        </Text>
        {updateLine ? (
          <Text style={[font('sans', 600), tnum, { fontSize: 14, lineHeight: 20, color: c.ink2, marginBottom: 10 }]}>
            {updateLine}
          </Text>
        ) : null}
        {rows.map((row, i) => (
          <View
            key={row.key}
            style={{ paddingVertical: 8, borderBottomWidth: i < rows.length - 1 ? 1 : 0, borderBottomColor: c.hairlineSoft }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
              <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>{row.label}</Text>
              <Text style={[font('mono', 400), tnum, { flexShrink: 1, fontSize: 12.5, color: c.ink, textAlign: 'right' }]}>
                {row.value}
              </Text>
            </View>
            {row.key === 'inOther' && summary.inOtherDecks > 0 ? (
              <View style={{ marginTop: 6 }}>
                {ELSEWHERE_OPTIONS.map((o) => (
                  <Choice key={o.id} on={prefs.elsewhere === o.id} title={o.label} onPress={() => onPrefs({ elsewhere: o.id })} />
                ))}
              </View>
            ) : null}
            {row.key === 'progress' && summary.progressCards > 0 ? (
              <ToggleRow
                label="Keep my Anki progress"
                on={prefs.progress === 'keep'}
                onChange={(on) => onPrefs({ progress: on ? 'keep' : 'reset' })}
              />
            ) : null}
            {row.key === 'images' && askImages ? (
              <ToggleRow label={askImages} on={prefs.images} onChange={(on) => onPrefs({ images: on })} />
            ) : null}
          </View>
        ))}
        {fieldsLine ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink2 }]}>{fieldsLine} · </Text>
            <Pressable onPress={onChangeFields} hitSlop={8} accessibilityRole="button" accessibilityLabel="Change fields">
              <Text style={[font('sans', 700), { fontSize: 13, color: c.pine }]}>Change</Text>
            </Pressable>
          </View>
        ) : null}
      </CardBox>

      {/* ---- notices (§5.6) */}
      {renamed ? <Notice text={renamed} /> : null}
      {summary.overlap.map((o) => (
        <Notice key={o.deckId} text={overlapText(o)} />
      ))}
      {summary.overlap.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <Btn kind="quiet" size="sm" onPress={() => onPrefs({ skipOverlap: !prefs.skipOverlap })}>
            {prefs.skipOverlap ? 'Import them anyway' : overlapSkipLabel(summary)}
          </Btn>
        </View>
      ) : null}

      {/* ---- how new cards start (only with the triage screen) */}
      {showNewCardsBlock(summary, TRIAGE_READY) ? (
        <View style={{ marginTop: 18 }}>
          <Overline style={{ marginBottom: 6 }}>How should new cards start?</Overline>
          {newCardsOptions(dailyNewLimit).map((o) => (
            <Choice
              key={o.id}
              on={prefs.arrival === o.id}
              title={`${o.title} — ${o.sub}`}
              onPress={() => onPrefs({ arrival: o.id })}
            />
          ))}
        </View>
      ) : null}
      {showPlacementBlock(summary, TRIAGE_READY) ? (
        <Placement summary={summary} prefs={prefs} onPrefs={onPrefs} />
      ) : null}

      {/* ---- actions */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <Btn kind="secondary" full style={{ flex: 1 }} onPress={onCancel}>
          Cancel
        </Btn>
        {live ? (
          <Btn full style={{ flex: 1.4 }} icon="download-outline" onPress={onImport}>
            {importButtonLabel(summary)}
          </Btn>
        ) : (
          <Btn full style={{ flex: 1.4 }} icon="checkmark" onPress={onClose}>
            Done
          </Btn>
        )}
      </View>

      <Sheet open={deckSheet} onClose={() => setDeckSheet(false)} title="Import into">
        {decks.map((d, i) => (
          <Pressable
            key={d.id}
            onPress={() => {
              onPrefs({ targetKind: 'existing', existingDeckId: d.id });
              setDeckSheet(false);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: d.id === prefs.existingDeckId }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 13,
              borderBottomWidth: i < decks.length - 1 ? 1 : 0,
              borderBottomColor: c.hairlineSoft,
            }}
          >
            <Text style={{ fontSize: 18 }}>{d.icon}</Text>
            <Text numberOfLines={1} style={[font('sans', 600), { flex: 1, fontSize: 15, color: c.ink }]}>
              {d.name}
            </Text>
            {d.id === prefs.existingDeckId ? <Ion name="checkmark" size={18} color={c.pine} /> : null}
          </Pressable>
        ))}
      </Sheet>
    </RiseIn>
  );
}

/* ---------------------------------------------------------------- parts */

/** One radio choice. */
function Choice({ on, title, onPress }: { on: boolean; title: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 }}
    >
      <Ion name={on ? 'radio-button-on' : 'radio-button-off'} size={19} color={on ? c.pine : c.ink3} />
      <Text style={[font('sans', on ? 600 : 400), { flex: 1, fontSize: 13.5, color: on ? c.ink : c.ink2 }]}>{title}</Text>
    </Pressable>
  );
}

/** A label with a switch, under a preview line. */
function ToggleRow({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <Text style={[font('sans', 600), { flex: 1, fontSize: 13.5, color: c.ink }]}>{label}</Text>
      <Toggle on={on} onChange={onChange} label={label} />
    </View>
  );
}

/** A quiet line under the preview card. */
function Notice({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, marginHorizontal: 2 }}>
      <Ion name="information-circle-outline" size={16} color={c.ink3} />
      <Text style={[font('sans', 400), { flex: 1, fontSize: 12.5, lineHeight: 18, color: c.ink2 }]}>{text}</Text>
    </View>
  );
}

/**
 * "Where do you start?" (spec §5.9): cards whose level is below the chosen
 * one become Known ("I know them") or stay Not started. The first level =
 * start from the beginning (no placement).
 */
function Placement({
  summary,
  prefs,
  onPrefs,
}: {
  summary: ImportSummary;
  prefs: ImportPrefs;
  onPrefs: (patch: Partial<ImportPrefs>) => void;
}) {
  const c = useColors();
  const groups = summary.placementGroups;
  const group = groups.find((g) => g.facet === prefs.placement?.facet) ?? groups[0];
  const fromRank = prefs.placement?.facet === group.facet ? prefs.placement.fromRank : 0;
  const below = prefs.placement?.below ?? 'known';
  const set = (facet: string, rank: number, how: 'known' | 'notStarted') =>
    onPrefs({ placement: rank > 0 ? { facet, fromRank: rank, below: how } : undefined });
  return (
    <View style={{ marginTop: 18 }}>
      <Overline style={{ marginBottom: 6 }}>Where do you start?</Overline>
      {groups.length > 1 ? (
        <View style={{ marginBottom: 8 }}>
          <SegCtrl
            size="sm"
            label="Group"
            value={group.facet}
            onChange={(facet) => set(facet, 0, below)}
            options={groups.map((g) => ({ id: g.facet, label: g.label }))}
          />
        </View>
      ) : null}
      <Text style={[font('sans', 600), { fontSize: 13.5, color: c.ink, marginBottom: 6 }]}>{group.label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {group.values.map((v, i) => (
          <Chip key={v} active={fromRank === i} onPress={() => set(group.facet, i, below)}>
            {v}
          </Chip>
        ))}
      </View>
      {fromRank > 0 ? (
        <View style={{ marginTop: 8 }}>
          <Text style={[font('sans', 400), { fontSize: 13, color: c.ink2, marginBottom: 2 }]}>Easier levels:</Text>
          <Choice on={below === 'known'} title="I know them" onPress={() => set(group.facet, fromRank, 'known')} />
          <Choice
            on={below === 'notStarted'}
            title="Leave them not started"
            onPress={() => set(group.facet, fromRank, 'notStarted')}
          />
        </View>
      ) : null}
    </View>
  );
}
