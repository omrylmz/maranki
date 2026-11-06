/**
 * Settings › Study & limits (spec §8.6, unit W4-5).
 *
 *   DAILY LIMITS — the most Study gives you
 *     New cards per day          [ - 10 + ]     0–999
 *     Reviews per day            [ - 200 + ]    10–9,999, or "No limit" (stored as 99,999)
 *   DAILY GOALS — for your bars on Today; never blocks cards
 *     Reviews goal               [ - 30 + ]     0 = Off
 *     New cards goal             [ - 10 + ]     0 = Off
 *   SESSION
 *     Session size               [ - 30 + ]     5–200, or "No limit" — applies to every session
 *     Default mode   (Flashcards | Typing | Quiz | Mixed)
 *     Hints · Retry missed cards · Space out both directions   [toggles]
 *     Known-card checks per day  [ - 5 + ]      0 = Off
 *
 * GOAL ≠ LIMIT (spec §7 #35). A goal is only the target of a bar on Today
 * (`setGoals`, which never writes a limit). A limit is what Study gives you
 * (`setLimits`, which keeps the review limit at 10 or more). The old screen
 * wrote the review LIMIT from the goal stepper, so "goal 0" hid every review.
 *
 * The steppers walk a ladder of useful values (settingsIndex.ts LADDERS), and
 * a stored value that is not on the ladder is added in its place, so the
 * number shown is always the real setting.
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';

import {
  LADDERS,
  ladderWith,
  MODE_LABEL,
  MODE_ORDER,
  PAGE_TITLE,
  sessionRank,
  stepWords,
} from '@/components/settings/settingsIndex';
import { InfoButton } from '@/components/sheets/InfoButton';
import { Page, Row, SectionHead, SegCtrl, StackBar, Stepper, Toggle } from '@/components/ui';
import { plural } from '@/domain/text';
import { NO_REVIEW_LIMIT } from '@/domain/types';
import { useData } from '@/store/DataContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface LadderRowProps {
  title: string;
  sub?: string;
  /** The stops of the stepper (LADDERS). */
  stops: readonly number[];
  /** The stored value. */
  value: number;
  onChange: (value: number) => void;
  /** The value as the stepper shows it ("No limit", "Off", "200"). */
  words: (value: number) => string;
  /** The value in words for a screen reader ("200 reviews per day"). */
  spoken: (value: number) => string;
  /** How stops are ordered (session size: 0 = "No limit" is the biggest). */
  rank?: (value: number) => number;
  last?: boolean;
}

/** A setting row with a stepper that walks a ladder of values. */
function LadderRow({ title, sub, stops, value, onChange, words, spoken, rank, last }: LadderRowProps) {
  const c = useColors();
  const ladder = ladderWith(stops, value, rank);
  const index = Math.max(0, ladder.indexOf(value));
  return (
    <Row padV={12} last={last}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink }]}>{title}</Text>
        {sub ? <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>{sub}</Text> : null}
      </View>
      <Stepper
        value={index}
        min={0}
        max={ladder.length - 1}
        step={1}
        fmt={(i) => words(ladder[i])}
        label={title}
        valueLabel={(i) => spoken(ladder[i])}
        onChange={(i) => onChange(ladder[i])}
      />
    </Row>
  );
}

/** A setting row with a switch. */
function ToggleRow({
  title,
  sub,
  on,
  onChange,
  last,
}: {
  title: string;
  sub?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  last?: boolean;
}) {
  const c = useColors();
  return (
    <Row padV={12} last={last}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink }]}>{title}</Text>
        {sub ? <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>{sub}</Text> : null}
      </View>
      <Toggle on={on} label={title} onChange={onChange} />
    </Row>
  );
}

/** The small line under a section head ("the most Study gives you"). */
function SectionNote({ children }: { children: string }) {
  const c = useColors();
  return <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginBottom: 2 }]}>{children}</Text>;
}

export default function StudySettingsScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const s = state.settings;
  const { goalReviews, goalNew } = state.person;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title={PAGE_TITLE.study} onBack={() => router.back()} />
      <Page pad={20}>
        <SectionHead action={<InfoButton term="Daily limit" />}>Daily limits</SectionHead>
        <SectionNote>The most Study gives you</SectionNote>
        <LadderRow
          title="New cards per day"
          stops={LADDERS.newPerDay}
          value={s.srs.dailyNewLimit}
          onChange={(v) => actions.setLimits({ dailyNewLimit: v })}
          words={stepWords.plain}
          spoken={(v) => `${plural(v, 'new card')} per day`}
        />
        <LadderRow
          title="Reviews per day"
          stops={LADDERS.reviewsPerDay}
          value={s.srs.dailyReviewLimit}
          onChange={(v) => actions.setLimits({ dailyReviewLimit: v })}
          words={stepWords.reviews}
          spoken={(v) => (v >= NO_REVIEW_LIMIT ? 'No review limit' : `${plural(v, 'review')} per day`)}
          last
        />

        <SectionHead action={<InfoButton term="Daily goal" />}>Daily goals</SectionHead>
        <SectionNote>For your bars on Today; never blocks cards</SectionNote>
        <LadderRow
          title="Reviews goal"
          stops={LADDERS.reviewsGoal}
          value={goalReviews}
          onChange={(v) => actions.setGoals(v, goalNew)}
          words={stepWords.offWhenZero}
          spoken={(v) => (v === 0 ? 'Off' : `${plural(v, 'review')} a day`)}
        />
        <LadderRow
          title="New cards goal"
          stops={LADDERS.newGoal}
          value={goalNew}
          onChange={(v) => actions.setGoals(goalReviews, v)}
          words={stepWords.offWhenZero}
          spoken={(v) => (v === 0 ? 'Off' : `${plural(v, 'new card')} a day`)}
          last
        />

        <SectionHead action={<InfoButton term="Session size" />}>Session</SectionHead>
        <LadderRow
          title="Session size"
          sub="Applies to every session"
          stops={LADDERS.sessionSize}
          value={s.sessionLimit}
          rank={sessionRank}
          onChange={(v) => actions.updateAppSettings({ sessionLimit: v })}
          words={stepWords.session}
          spoken={(v) => (v === 0 ? 'No session limit' : `Sessions of ${plural(v, 'card')}`)}
        />
        <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.hairlineSoft }}>
          <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink, marginBottom: 8 }]}>Default mode</Text>
          <SegCtrl
            label="Default mode"
            size="sm"
            value={s.studyMode}
            onChange={(id) => actions.updateAppSettings({ studyMode: id as typeof s.studyMode })}
            options={MODE_ORDER.map((m) => ({ id: m, label: MODE_LABEL[m] }))}
          />
        </View>
        <ToggleRow
          title="Hints"
          sub="Show a Hint button before you reveal the answer"
          on={s.hintsEnabled}
          onChange={(v) => actions.updateAppSettings({ hintsEnabled: v })}
        />
        <ToggleRow
          title="Retry missed cards"
          sub="Offer a practice round for cards you missed"
          on={s.retryMissed}
          onChange={(v) => actions.updateAppSettings({ retryMissed: v })}
        />
        <ToggleRow
          title="Space out both directions"
          sub="Never show both directions of one item on the same day"
          on={s.spaceSiblings}
          onChange={(v) => actions.updateAppSettings({ spaceSiblings: v })}
        />
        <LadderRow
          title="Known-card checks per day"
          sub="A quick test of a few cards you marked as known"
          stops={LADDERS.knownChecks}
          value={s.knownChecksPerDay}
          onChange={(v) => actions.updateAppSettings({ knownChecksPerDay: v })}
          words={stepWords.offWhenZero}
          spoken={(v) => (v === 0 ? 'Off' : `${plural(v, 'check')} per day`)}
          last
        />
      </Page>
    </View>
  );
}
