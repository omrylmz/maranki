/**
 * Settings › Algorithm (spec §8.6, unit W4-5): the SM-2 knobs of the one
 * scheduler (src/domain/srs.ts). They were a local drill-in of the old
 * settings.tsx; now this is a real route, so Android's back closes it.
 *
 * Every knob writes `settings.srs` through `updateSrsSettings` and applies at
 * once (the next rating uses it). A knob that differs from its default shows
 * "Reset to default (…)". The daily limits are NOT here: they live on
 * Study & limits (`setLimits`, which keeps the review limit at 10 or more).
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { ladderWith, PAGE_TITLE } from '@/components/settings/settingsIndex';
import { A11Y_HIDDEN, Ion, Page, SegCtrl, StackBar, Stepper } from '@/components/ui';
import { formatDelay } from '@/domain/srs';
import { DEFAULT_SRS, MIN, type SrsSettings } from '@/domain/types';
import { useData } from '@/store/DataContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The learning-step presets (minutes). */
const STEP_PRESETS: Record<string, number[]> = {
  relaxed: [10, 60],
  standard: [1, 10],
  intensive: [1, 5, 15],
};

function presetOf(steps: number[]): string {
  const key = steps.join(',');
  return Object.keys(STEP_PRESETS).find((p) => STEP_PRESETS[p].join(',') === key) ?? 'custom';
}

/** The stops of "Maximum interval" (days). */
const MAX_INTERVAL_STOPS = [30, 60, 90, 180, 365, 730, 1825, 3650, 36500];

/** Days in words: 30 → "30 days", 365 → "1 year", 36500 → "100 years". */
function daysWords(days: number): string {
  if (days >= 365 && days % 365 === 0) {
    const years = days / 365;
    return `${years} ${years === 1 ? 'year' : 'years'}`;
  }
  return `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;
}

const times = (n: number) => `${n.toFixed(2)}×`;
const daysShort = (n: number) => `${n}d`;

interface Knob {
  key: keyof SrsSettings;
  label: string;
  plain: (value: number) => string;
  min: number;
  max: number;
  step: number;
  fmt: (n: number) => string;
}

const KNOBS: Knob[] = [
  {
    key: 'graduatingIntervalDays',
    label: 'Graduating interval',
    plain: (v) => `A card that finishes its learning steps comes back in ${daysWords(v)}`,
    min: 1,
    max: 30,
    step: 1,
    fmt: daysShort,
  },
  {
    key: 'easyIntervalDays',
    label: 'Easy interval',
    plain: (v) => `"Easy" on a new card skips the steps: back in ${daysWords(v)}`,
    min: 1,
    max: 60,
    step: 1,
    fmt: daysShort,
  },
  {
    key: 'startingEase',
    label: 'Starting ease',
    plain: (v) => `Each "Good" grows the interval about ${v.toFixed(2)}×`,
    min: 1.3,
    max: 5,
    step: 0.05,
    fmt: times,
  },
  {
    key: 'easyBonus',
    label: 'Easy bonus',
    plain: (v) => `Easy cards wait ${Math.round((v - 1) * 100)}% longer`,
    min: 1,
    max: 3,
    step: 0.05,
    fmt: times,
  },
  {
    key: 'hardMultiplier',
    label: 'Hard interval',
    plain: (v) => `Hard cards grow at ${v.toFixed(2)}× pace`,
    min: 1,
    max: 1.5,
    step: 0.05,
    fmt: times,
  },
  {
    key: 'lapseMultiplier',
    label: 'Lapse multiplier',
    plain: (v) => `A forgotten card keeps ${Math.round(v * 100)}% of its interval`,
    min: 0,
    max: 1,
    step: 0.05,
    fmt: times,
  },
  {
    key: 'intervalModifier',
    label: 'Interval modifier',
    plain: () => 'Scales every interval — lower studies more often',
    min: 0.5,
    max: 1.5,
    step: 0.05,
    fmt: times,
  },
];

export default function AlgorithmScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const srs = state.settings.srs;
  const preset = presetOf(srs.learningStepsMin);

  const resetLink = (label: string, onPress: () => void) => (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" style={{ paddingTop: 6, alignSelf: 'flex-start' }}>
      <Text style={[font('sans', 700), { fontSize: 12, color: c.pine }]}>{label}</Text>
    </Pressable>
  );

  const knobRow = (k: Knob) => {
    const value = srs[k.key] as number;
    const dflt = DEFAULT_SRS[k.key] as number;
    const set = (v: number) => actions.updateSrsSettings({ [k.key]: Math.round(v * 100) / 100 } as Partial<SrsSettings>);
    return (
      <View key={k.key} style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.hairlineSoft }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>{k.label}</Text>
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}>{k.plain(value)}</Text>
          </View>
          <Stepper value={value} onChange={set} min={k.min} max={k.max} step={k.step} fmt={k.fmt} label={k.label} />
        </View>
        {value !== dflt ? resetLink(`Reset to default (${k.fmt(dflt)})`, () => set(dflt)) : null}
      </View>
    );
  };

  // Maximum interval walks a ladder of stops (30 days … 100 years).
  const maxLadder = ladderWith(MAX_INTERVAL_STOPS, srs.maxIntervalDays);
  const maxIndex = Math.max(0, maxLadder.indexOf(srs.maxIntervalDays));

  const stepsLine = `steps: ${srs.learningStepsMin.map((m) => formatDelay(m * MIN)).join(' → ')} · graduate at ${srs.graduatingIntervalDays}d`;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title={PAGE_TITLE.algorithm} sub="SM-2 settings — changes apply at once" onBack={() => router.back()} />
      <Page pad={20}>
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            alignItems: 'flex-start',
            backgroundColor: c.warningTint,
            borderRadius: 12,
            paddingVertical: 11,
            paddingHorizontal: 14,
            marginTop: 14,
          }}
        >
          <View {...A11Y_HIDDEN}>
            <Ion name="warning-outline" size={17} color={c.warning} style={{ marginTop: 1 }} />
          </View>
          <Text style={[font('sans', 400), { flex: 1, fontSize: 13, lineHeight: 19, color: c.ink }]}>
            These knobs reshape your review schedule. The defaults work well for most learners.
          </Text>
        </View>

        <View style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.hairlineSoft }}>
          <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink, marginBottom: 8 }]}>Learning steps</Text>
          <SegCtrl
            label="Learning steps"
            value={preset}
            onChange={(id) => {
              if (STEP_PRESETS[id]) actions.updateSrsSettings({ learningStepsMin: STEP_PRESETS[id] });
            }}
            options={[
              { id: 'relaxed', label: 'Relaxed' },
              { id: 'standard', label: 'Standard' },
              { id: 'intensive', label: 'Intensive' },
            ]}
          />
          <Text style={[font('mono', 400), { fontSize: 12, color: c.ink3, marginTop: 8 }]}>{stepsLine}</Text>
        </View>

        {KNOBS.map(knobRow)}

        <View style={{ paddingVertical: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>Maximum interval</Text>
              <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}>
                No card waits longer than {daysWords(srs.maxIntervalDays)}
              </Text>
            </View>
            <Stepper
              value={maxIndex}
              min={0}
              max={maxLadder.length - 1}
              step={1}
              fmt={(i) => daysWords(maxLadder[i])}
              label="Maximum interval"
              onChange={(i) => actions.updateSrsSettings({ maxIntervalDays: maxLadder[i] })}
            />
          </View>
          {srs.maxIntervalDays !== DEFAULT_SRS.maxIntervalDays
            ? resetLink(`Reset to default (${daysWords(DEFAULT_SRS.maxIntervalDays)})`, () =>
                actions.updateSrsSettings({ maxIntervalDays: DEFAULT_SRS.maxIntervalDays }),
              )
            : null}
        </View>
      </Page>
    </View>
  );
}
