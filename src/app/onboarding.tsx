/**
 * Onboarding (`/onboarding`, spec §8.9, unit W4-5): a first run that ENDS IN
 * AN ACTION.
 *
 *   1 Welcome      "Learn anything. Keep it." · three points · "Get started" · quiet "Skip"
 *   2 Time         "How much time a day?" · "5 new a day · about 8 min" ·
 *                  "10 new a day · about 15 min" · "20 new a day · about 31 min"
 *                  (about 3 reviews for each new card; the minutes ARE
 *                  minutesFor(new + reviews), wave 5d) · "You can change this any time."
 *                  (writes the new-card limit and the two goals — never the review
 *                  limit). A first run selects the middle answer: the pace a new
 *                  install already has (seed.ts `DEFAULT_PACE`), so "Continue" writes
 *                  nothing new. A replay selects the learner's own pace, or "Keep my
 *                  pace" (`tourPace`).
 *   3 Reminder     "Want a daily reminder?" · time · "Remind me at 8:00 PM" (the
 *                  permission flow) · "Not now". A first run offers 8:00 PM
 *                  (`tourReminderTime`, wave 5b L7); a replay offers the learner's time.
 *   4 First cards  a content pack's own first choice on top (German: "Start with
 *                  German" → "Where do you start?" → the starter decks) ·
 *                  "Import a deck" · "Find a deck on AnkiWeb" · "Make my own deck" ·
 *                  quiet "I'll do this later". Each one marks the tour done and
 *                  STARTS that action (`router.replace`; Today: `backToToday`, which
 *                  goes back to the tab navigator under the tour).
 *
 * The pack's first choice (German build, unit W5-1), end to end:
 *
 *   "Start with German"  →  "Where do you start?"  I'm just starting · A1 · A2 … C2
 *                        →  "Adding your decks…"   one line per starter deck:
 *                                                  Waiting / Adding… / 13,690 cards added / the error
 *                        →  all added: the tour is done → "Choose what to learn" (triage over
 *                           the Not started cards of the new decks), or Today when none is left
 *                        →  one failed: the list stays, with "Try again" (only the decks
 *                           that are missing) and "Continue without them".
 *
 *   - The decks are added ONE AFTER ANOTHER with the same idempotent loader
 *     as the AddSheet (src/domain/starterDecks.ts `addStarterDeck`): a deck
 *     that is already there is found by its sourceKey and changes nothing,
 *     so "Try again" (or the tour after the app was killed half way) never
 *     makes a deck twice.
 *   - "Where do you start?" is given BY VALUE (StarterPlacement, e.g. 'A2'):
 *     the cards of easier levels are marked Known in the same import step.
 *   - New cards start as Not started ("Let me choose what to learn"): the
 *     decks bring 15,960 cards, far more than the 1,000 of decision D3. So
 *     the tour ends in "Choose what to learn" (spec §11 E12).
 *   - A deck counts as added only when its save COMMITTED (`saved.ok`); a
 *     save that failed is shown as that deck's error (saveWarning), and its
 *     "Try again" saves again. That deck IS in the library already (in
 *     memory), so the row keeps what the failed try did (`unsaved`: its
 *     cards, its "marked Known" count, its decks). "Try again" then finds
 *     the deck, changes nothing and only saves, and the row still says
 *     "13,690 cards added · …", not "Already up to date." (AddSheet.tsx
 *     `starterRunRowAfter`). The kept try also survives going back to
 *     "Where do you start?" and picking another level.
 *   - "Continue" after a failure counts honestly (`starterRunCounts`): a
 *     deck that is in the library but not saved yet is "added but not saved
 *     yet", never "could not be added". The button says "Continue without
 *     them" only when a deck is really missing. The row's own line agrees:
 *     a later try of such a deck that throws keeps "not saved" on its line
 *     (`starterRunRowThrew`, review round 2).
 *   - One run at a time (`starterTaskGuard`): a second tap starts nothing.
 *   - After EVERY save of the run, every row is checked again
 *     (`starterRunRowsAfterTry`, wave 5b R4): a save writes the whole
 *     library, so a deck whose own save failed is on the disk as soon as a
 *     later deck's save commits. Its row then says what was added, not
 *     "not saved yet".
 *
 * "Replay the tour" (`/onboarding?replay=1`, Settings): every step is
 * pre-filled with the CURRENT values, only what the user changes is written
 * (onboardingDiff.ts), and step 4 is skipped. A replay never touches
 * `onboarded`. (The old tour wrote its defaults on every replay and quietly
 * reset the learner's limits, spec §7 #36.)
 *
 * WHEN things are written: the pace on "Continue" of step 2 (a diff against
 * the values of NOW); the reminder at the tap on step 3 (turning it on needs
 * the system prompt right then). On a first run, "Not now" also keeps the
 * time the step showed (8:00 PM), so a later "Want a daily reminder?" on
 * Today offers the same time (`declineReminderPatch`). "Skip" leaves without
 * writing anything more.
 *
 * Android's hardware back goes one step back; on the first step it leaves
 * like "Skip".
 *
 * The tour has its OWN SnackbarHost (review round 1). It is a full-screen
 * modal, so it covers the (tabs) screen and the host there. Two messages
 * must still be seen while the tour is open:
 *   - "Erase everything" opens the tour at once (onboarded becomes false),
 *     and only after that the Settings screen says whether the erase was
 *     saved ("The erase was not saved — …");
 *   - this screen's own messages, for example "We couldn't turn on
 *     reminders. Please try again." on step 3.
 */
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  starterDepsFor,
  starterRunCounts,
  starterRunRow,
  starterRunRowsAfterTry,
  starterRunRowThrew,
  type StarterRunRow,
  starterRunSummary,
  starterTaskGuard,
  type StarterTry,
} from '@/components/sheets/AddSheet';
import {
  applyOnboardingDiff,
  applyPace,
  declineReminderPatch,
  FIRST_CARDS_CHOICES,
  type FirstCardsChoice,
  ONBOARDING_COPY,
  onboardingDiff,
  onboardingSteps,
  onboardingValues,
  ownPaceLabel,
  PACES,
  type PaceId,
  PLACEMENT_LEVELS,
  reminderChange,
  remindMeLabel,
} from '@/components/settings/onboardingDiff';
import { tourPace, tourReminderTime } from '@/components/settings/settingsIndex';
import { backToToday, TODAY_HREF } from '@/components/today/backToToday';
import { triageRoute } from '@/components/today/todayLogic';
import { A11Y_HIDDEN, Btn, CardBox, Ion, RiseIn, Row, SnackbarHost } from '@/components/ui';
import type { Query } from '@/domain/model';
import { matchCtxOf, scopePool } from '@/domain/scope';
import { addStarterDeck, type StarterPlacement, type StarterPlanOptions } from '@/domain/starterDecks';
import { foldText } from '@/domain/text';
import { useData } from '@/store/DataContext';
import {
  enableReminders,
  formatReminderTime,
  REMINDER_COPY,
  reminderPickerValue,
  reminderTimeOf,
  syncReminders,
} from '@/store/reminderSync';
import { useEngine } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';
import { activePack } from '@/variants';

/** The pace answer: one of the three, or (replay) the learner's own values. */
type PaceChoice = PaceId | 'own';

/** The run of the pack's first choice: the level picked and one row per starter deck. */
interface PackRun {
  /** The "Where do you start?" answer ('A2'), or null ("I'm just starting"). */
  fromValue: string | null;
  rows: StarterRunRow[];
}

/** The words of the progress list (spec §8.9; the list itself is W5-1). */
const PACK_RUN_COPY = {
  waiting: 'Waiting',
  adding: 'Adding…',
  // The line of a deck that could not be added: STARTER_RUN_LINE (AddSheet.tsx, starterRunRowThrew).
  failedTitle: 'Some decks could not be added',
  failedNote: 'Try again to add the decks that are missing. The others are already in your library.',
  // Every failed deck is in the library, only its save did not commit.
  unsavedTitle: 'Some decks are not saved yet',
  unsavedNote: 'They are in your library, but saving failed. Try again to save them.',
  tryAgain: 'Try again',
  continueWithout: 'Continue without them',
  continueAnyway: 'Continue',
  progress: (done: number, total: number) => `${done} of ${total} added`,
} as const;

/** A big, selectable answer (a radio button that looks like a card). */
function Choice({
  title,
  sub,
  selected,
  onPress,
  role = 'radio',
}: {
  title: string;
  sub?: string;
  selected?: boolean;
  onPress: () => void;
  role?: 'radio' | 'button';
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityState={role === 'radio' ? { checked: !!selected } : undefined}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: selected ? c.pineTint : c.card,
          borderWidth: 1,
          borderColor: selected ? c.pine : c.hairline,
          borderRadius: 16,
          paddingVertical: 15,
          paddingHorizontal: 16,
          marginBottom: 10,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
        c.shadow.sm,
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>{title}</Text>
        {sub ? <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, marginTop: 2 }]}>{sub}</Text> : null}
      </View>
      <View {...A11Y_HIDDEN}>
        <Ion
          name={role === 'radio' ? (selected ? 'radio-button-on' : 'radio-button-off') : 'chevron-forward'}
          size={role === 'radio' ? 20 : 17}
          color={selected ? c.pine : c.ink3}
        />
      </View>
    </Pressable>
  );
}

export default function OnboardingScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const now = useNow();
  const engine = useEngine();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ replay?: string }>();
  const replay = params.replay === '1';
  const steps = onboardingSteps(replay);

  // The values when the tour opened: the pre-fill of every step.
  const [initial] = useState(() => onboardingValues(state));
  const [stepIndex, setStepIndex] = useState(0);
  // What the Time step selects first: a first run the middle answer, "10 new a day" (its
  // values were never the learner's choice); a replay the learner's own pace, or "Keep my
  // pace" (wave 5b L6).
  const paceStart = tourPace(initial, replay);
  const [pace, setPace] = useState<PaceChoice>(paceStart.selected);
  // A first run offers 8:00 PM; a replay (or reminders that are on) the learner's own time.
  const [time, setTime] = useState(() => tourReminderTime(initial, replay));
  const [picking, setPicking] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  // Step 4, the pack's own choice: "Where do you start?" and then adding the decks.
  const [placing, setPlacing] = useState(false);
  // The last run stays after "back" (its unsaved tries are needed by the next run);
  // `runOpen` says whether its list is on screen.
  const [packRun, setPackRun] = useState<PackRun | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [packBusy, setPackBusy] = useState<string | null>(null);
  // The same guard object in every render: a second tap never starts a second run.
  const [packGuard] = useState(() => starterTaskGuard(setPackBusy));
  const adding = packBusy !== null;

  const step = steps[stepIndex];
  const reminderOn = state.settings.reminderEnabled;
  const firstChoice = activePack.onboarding?.firstChoice;
  const placementField = activePack.onboarding?.placementField;

  /**
   * Leave the tour: a replay goes back to Settings; a first run lands on Today
   * (backToToday: back to the ONE tab navigator under the tour, never a second
   * `(tabs)` route on top of it).
   */
  const leave = () => {
    if (replay) router.back();
    else backToToday(router);
  };

  /** "Skip": the first run is done (nothing else is written); a replay just closes. */
  const skip = () => {
    if (!replay) actions.markOnboarded();
    leave();
  };

  const next = () => {
    if (stepIndex < steps.length - 1) setStepIndex(stepIndex + 1);
    else leave();
  };

  // Android's back: one step back; on the first step it is "Skip".
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (adding) return true;
      // The list after a failed try: back to "Where do you start?" (the added decks stay).
      if (packRun && runOpen) {
        setRunOpen(false);
        return true;
      }
      if (placing) {
        setPlacing(false);
        return true;
      }
      if (stepIndex > 0) {
        setStepIndex(stepIndex - 1);
        return true;
      }
      if (!replay) actions.markOnboarded();
      return false;
    });
    return () => sub.remove();
  }, [stepIndex, placing, adding, packRun, runOpen, replay, actions]);

  /* ---------------------------------------------------------- step 2 */

  const chosenPaceValues = () => (pace === 'own' ? initial : applyPace(initial, pace));

  /** "Continue" on the Time step: write only what differs from the values of NOW. */
  const savePace = () => {
    const current = onboardingValues(engine.store.getState());
    applyOnboardingDiff(onboardingDiff(current, { ...current, ...pick3(chosenPaceValues()) }), actions);
    next();
  };

  /* ---------------------------------------------------------- step 3 */

  const remindMe = async () => {
    if (reminderBusy) return;
    const current = onboardingValues(engine.store.getState());
    const change = reminderChange(current, { reminderEnabled: true, reminderTime: time });
    if (change.kind === 'none') {
      next();
      return;
    }
    if (change.kind === 'time') {
      actions.updateAppSettings({ reminderTime: change.time });
      void syncReminders(engine.store.getState(), Date.now());
      next();
      return;
    }
    if (change.kind !== 'enable') return;
    setReminderBusy(true);
    const outcome = await enableReminders(
      {
        updateAppSettings: actions.updateAppSettings,
        getState: () => engine.store.getState(),
        now: () => Date.now(),
      },
      change.time,
    );
    setReminderBusy(false);
    if (outcome.kind === 'denied') {
      setDenied(true);
      return;
    }
    if (outcome.kind === 'failed') {
      show(REMINDER_COPY.failed);
      return;
    }
    next();
  };

  /**
   * "Not now" (off) or "Turn off reminders" (reminders on). A first run keeps the time it
   * showed (8:00 PM unless changed), so Today's later "Want a daily reminder?" offers the
   * same time (wave 5b L7); reminders stay off. The rule: onboardingDiff.ts `declineReminderPatch`.
   */
  const declineReminder = () => {
    const patch = declineReminderPatch(engine.store.getState().settings, time, replay);
    if (patch) {
      actions.updateAppSettings(patch);
      // Turning reminders off cancels the planned notifications.
      if (patch.reminderEnabled === false) void syncReminders(engine.store.getState(), Date.now());
    }
    next();
  };

  const pickTime = (date: Date | null | undefined) => {
    setPicking(false);
    if (date instanceof Date && !Number.isNaN(date.getTime())) setTime(reminderTimeOf(date));
  };

  /* ---------------------------------------------------------- step 4 */

  /** A big choice: the tour is done, and the action starts now. */
  const startAction = (choice: FirstCardsChoice) => {
    actions.markOnboarded();
    // "I'll do this later" goes back to the tabs under the tour (one tab navigator, backToToday).
    if (choice.route === TODAY_HREF) backToToday(router);
    // These routes exist; '/import?…' carries a query, so typed routes need the cast.
    else router.replace(choice.route as Href);
  };

  /**
   * The tour is done: open "Choose what to learn" over the Not started cards
   * of the decks in the library (or Today when there are none), and say what
   * was added. A deck whose save did not commit IS in the library: it counts
   * as "added but not saved yet" (starterRunCounts), not as missing.
   */
  const finishPack = (rows: readonly StarterRunRow[]) => {
    const counts = starterRunCounts(rows);
    const deckIds = counts.deckIds;
    actions.markOnboarded();
    // The same scope as Today's "Choose what to learn", for these decks only.
    const q: Query = { decks: deckIds, life: ['notStarted'], notFlags: ['suspended'] };
    const state = engine.store.getState();
    const notStarted = deckIds.length > 0 ? scopePool(state, q, matchCtxOf(state, Date.now()), 'browse').length : 0;
    // '/triage?q=' carries a query, so typed routes need the cast. No card left: Today (backToToday).
    if (notStarted > 0) router.replace(triageRoute(q) as Href);
    else backToToday(router);
    show(starterRunSummary(counts.added, counts.missing, counts.markedKnown, counts.unsaved));
  };

  /**
   * The pack's own first choice: add every starter deck, one after another
   * (placement by value), with a line per deck. All added → finishPack. A
   * failure keeps the list on screen with "Try again".
   *
   * A try after a failure, with the same level, keeps the rows that are
   * already added and adds only the others. With another level, every deck
   * is added again: the ones already there answer "Already up to date." and
   * keep their cards as they are (the new level applies to the new decks;
   * Choose what to learn has its own "Where do you start?"). A deck whose
   * save did not commit keeps that try (`unsaved`) in the new run too, so
   * its line still says what was really added.
   */
  const startWithPack = (fromValue: string | null) => {
    void packGuard.run('pack', async () => {
      const placement: StarterPlacement | undefined =
        fromValue !== null && placementField
          ? { facet: `field:${foldText(placementField)}`, fromValue, below: 'known' }
          : undefined;
      // "Let me choose what to learn" (decision D3): every new card starts Not started.
      const opts: StarterPlanOptions = placement ? { arrival: 'notStarted', placement } : { arrival: 'notStarted' };
      const deps = starterDepsFor(engine);
      // The tries of the last run that are applied but not saved, by starter key.
      const kept = new Map<string, StarterTry>();
      for (const r of packRun?.rows ?? []) if (r.unsaved) kept.set(r.starter.key, r.unsaved);
      const rows: StarterRunRow[] =
        packRun && packRun.fromValue === fromValue
          ? packRun.rows.map((r) => ({ ...r }))
          : activePack.starterDecks.map((starter) => starterRunRow(starter, kept.get(starter.key) ?? null));
      const publish = () => setPackRun({ fromValue, rows: rows.map((r) => ({ ...r })) });
      setRunOpen(true);
      for (let i = 0; i < rows.length; i++) {
        const before = rows[i];
        if (before.status === 'added') continue;
        const row: StarterRunRow = { ...before, status: 'adding', line: '' };
        rows[i] = row;
        publish();
        try {
          const outcome = await addStarterDeck(activePack, row.starter.key, deps, opts);
          // An earlier try was applied but not saved, and this one saved nothing: save it now.
          const saved = outcome.saved ?? (row.unsaved ? await deps.flush() : null);
          // This row says what the try did. A save writes the WHOLE library: the other decks
          // that waited for a save are on the disk now too, so every row is checked again (wave 5b R4).
          const after = starterRunRowsAfterTry(rows, i, outcome, saved);
          for (let j = 0; j < rows.length; j++) rows[j] = after[j];
        } catch {
          // Nothing of THIS try was applied. An earlier unsaved try stays in `unsaved`
          // (its deck is in the library), and the line says "not saved", not "Could not be added.".
          rows[i] = starterRunRowThrew(before);
        }
        publish();
      }
      if (rows.every((r) => r.status === 'added')) finishPack(rows);
    });
  };

  const onPackChoice = () => {
    if (placementField) setPlacing(true);
    else startWithPack(null);
  };

  /* ------------------------------------------------------------ body */

  const title = (text: string) => (
    <Text
      accessibilityRole="header"
      style={[font('serif', 600), { fontSize: 28, lineHeight: 33, color: c.ink, marginTop: 24, marginBottom: 6 }]}
    >
      {text}
    </Text>
  );
  const note = (text: string) => (
    <Text style={[font('sans', 400), { fontSize: 14, lineHeight: 20, color: c.ink2, marginBottom: 16 }]}>{text}</Text>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (step === 'welcome') {
    body = (
      <RiseIn key="welcome" duration={300}>
        <View style={{ alignItems: 'center' }}>
          <Text style={[font('serif', 600), { fontSize: 44, letterSpacing: -0.88, color: c.ink, marginTop: 30 }]}>
            Maranki
          </Text>
          <Text style={[font('serif', 400, true), { fontSize: 19, color: c.ink2, marginTop: 10, marginBottom: 30 }]}>
            {activePack.onboarding?.tagline ?? ONBOARDING_COPY.tagline}
          </Text>
        </View>
        <CardBox>
          {(
            [
              ['albums-outline', 'Study a few cards a day', 'Short sessions that fit your day.'],
              ['repeat', 'We bring each card back', 'Just before you’d forget it — that’s spaced repetition.'],
              ['flame', 'Streaks make it stick', 'A little every day beats a lot once a week.'],
            ] as [string, string, string][]
          ).map(([icon, t, sub], i, arr) => (
            <Row key={t} padV={11} last={i === arr.length - 1} style={{ alignItems: 'flex-start' }}>
              <View
                {...A11Y_HIDDEN}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 11,
                  backgroundColor: c.pineTint,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ion name={icon} size={17} color={c.pine} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>{t}</Text>
                <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, marginTop: 1 }]}>{sub}</Text>
              </View>
            </Row>
          ))}
        </CardBox>
      </RiseIn>
    );
    footer = (
      <Btn full size="lg" icon="arrow-forward" onPress={next}>
        {ONBOARDING_COPY.getStarted}
      </Btn>
    );
  } else if (step === 'time') {
    body = (
      <RiseIn key="time" duration={300}>
        {title(ONBOARDING_COPY.timeTitle)}
        {note(ONBOARDING_COPY.timeNote)}
        {PACES.map((p) => (
          <Choice key={p.id} title={p.label} selected={pace === p.id} onPress={() => setPace(p.id)} />
        ))}
        {paceStart.offerOwn ? (
          <Choice title={ownPaceLabel(initial)} selected={pace === 'own'} onPress={() => setPace('own')} />
        ) : null}
      </RiseIn>
    );
    footer = (
      <Btn full size="lg" onPress={savePace}>
        {ONBOARDING_COPY.continue}
      </Btn>
    );
  } else if (step === 'reminder') {
    const timeLabel = formatReminderTime(time);
    body = (
      <RiseIn key="reminder" duration={300}>
        {title(ONBOARDING_COPY.reminderTitle)}
        {note(
          reminderOn
            ? `Your daily reminder is on at ${formatReminderTime(state.settings.reminderTime)}.`
            : 'One quiet nudge a day, at a time you choose. Days you already studied are skipped.',
        )}
        <CardBox pad={4} style={{ paddingHorizontal: 16 }}>
          {Platform.OS === 'ios' ? (
            <Row padV={10} last>
              <Text style={[font('sans', 700), { flex: 1, fontSize: 15, color: c.ink }]}>{REMINDER_COPY.time}</Text>
              <DateTimePicker
                mode="time"
                display="compact"
                value={reminderPickerValue(time, now)}
                accentColor={c.pine}
                onValueChange={(_event, date) => pickTime(date)}
              />
            </Row>
          ) : (
            <Row
              padV={14}
              last
              onPress={Platform.OS === 'android' ? () => setPicking(true) : undefined}
              label={`${REMINDER_COPY.time} ${timeLabel}`}
              hint={Platform.OS === 'android' ? 'Opens the time picker' : undefined}
            >
              <Text style={[font('sans', 700), { flex: 1, fontSize: 15, color: c.ink }]}>{REMINDER_COPY.time}</Text>
              <Text style={[font('sans', 700), tnum, { fontSize: 15, color: c.ink }]}>{timeLabel}</Text>
              {Platform.OS === 'android' ? (
                <View {...A11Y_HIDDEN}>
                  <Ion name="chevron-forward" size={16} color={c.ink3} />
                </View>
              ) : null}
            </Row>
          )}
        </CardBox>
        {Platform.OS === 'android' && picking ? (
          <DateTimePicker
            mode="time"
            presentation="dialog"
            is24Hour={false}
            value={reminderPickerValue(time, now)}
            accentColor={c.pine}
            onValueChange={(_event, date) => pickTime(date)}
            onDismiss={() => setPicking(false)}
          />
        ) : null}
        {denied ? (
          <View
            style={{
              backgroundColor: c.warningTint,
              borderRadius: 12,
              paddingVertical: 12,
              paddingHorizontal: 14,
              marginTop: 16,
              gap: 10,
            }}
          >
            <Text style={[font('sans', 400), { fontSize: 13.5, lineHeight: 20, color: c.ink }]}>
              {REMINDER_COPY.denied}
            </Text>
            <Btn kind="secondary" size="sm" icon="settings-outline" onPress={() => void Linking.openSettings()}>
              {REMINDER_COPY.openSettings}
            </Btn>
          </View>
        ) : null}
      </RiseIn>
    );
    footer = denied ? (
      <Btn full size="lg" onPress={next}>
        {ONBOARDING_COPY.continue}
      </Btn>
    ) : (
      <View style={{ gap: 10 }}>
        <Btn full size="lg" icon="notifications-outline" disabled={reminderBusy} onPress={() => void remindMe()}>
          {remindMeLabel(timeLabel)}
        </Btn>
        <Btn full kind="quiet" disabled={reminderBusy} onPress={declineReminder}>
          {reminderOn ? ONBOARDING_COPY.turnOff : ONBOARDING_COPY.notNow}
        </Btn>
      </View>
    );
  } else if (packRun && runOpen) {
    // The progress list of the pack's first choice (see the file comment).
    const run = packRun;
    const total = run.rows.length;
    const counts = starterRunCounts(run.rows);
    const failed = !adding && run.rows.some((r) => r.status === 'failed');
    // Only saves failed: every deck is in the library, so "Continue" leaves none out.
    const onlyUnsaved = counts.missing === 0;
    body = (
      <RiseIn key="pack" duration={300}>
        {title(failed ? (onlyUnsaved ? PACK_RUN_COPY.unsavedTitle : PACK_RUN_COPY.failedTitle) : ONBOARDING_COPY.adding)}
        {note(
          failed
            ? onlyUnsaved
              ? PACK_RUN_COPY.unsavedNote
              : PACK_RUN_COPY.failedNote
            : PACK_RUN_COPY.progress(counts.added, total),
        )}
        <CardBox pad={4} style={{ paddingHorizontal: 16 }}>
          {/* Android reads each new line out (a screen reader hears the progress). */}
          <View accessibilityLiveRegion="polite">
            {run.rows.map((row, i) => (
              <Row key={row.starter.key} padV={12} last={i === total - 1}>
                <View {...A11Y_HIDDEN} style={{ width: 24, alignItems: 'center' }}>
                  {row.status === 'adding' ? (
                    <ActivityIndicator size="small" color={c.pine} />
                  ) : (
                    <Ion
                      name={row.status === 'added' ? 'checkmark-circle' : row.status === 'failed' ? 'alert-circle' : 'ellipse-outline'}
                      size={20}
                      color={row.status === 'added' ? c.success : row.status === 'failed' ? c.danger : c.ink3}
                    />
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>{row.starter.title}</Text>
                  <Text
                    style={[
                      font('sans', 400),
                      { fontSize: 13, lineHeight: 18, color: row.status === 'failed' ? c.danger : c.ink3, marginTop: 1 },
                    ]}
                  >
                    {row.status === 'waiting'
                      ? PACK_RUN_COPY.waiting
                      : row.status === 'adding'
                        ? PACK_RUN_COPY.adding
                        : row.line}
                  </Text>
                </View>
              </Row>
            ))}
          </View>
        </CardBox>
      </RiseIn>
    );
    footer = failed ? (
      <View style={{ gap: 10 }}>
        <Btn full size="lg" icon="refresh" onPress={() => startWithPack(run.fromValue)}>
          {PACK_RUN_COPY.tryAgain}
        </Btn>
        <Btn full kind="quiet" onPress={() => finishPack(run.rows)}>
          {onlyUnsaved ? PACK_RUN_COPY.continueAnyway : PACK_RUN_COPY.continueWithout}
        </Btn>
      </View>
    ) : null;
  } else if (placing) {
    body = (
      <RiseIn key="placement" duration={300}>
        {title(ONBOARDING_COPY.placementTitle)}
        {note('Cards below your level are marked as known. You can change any card later.')}
        <Choice role="button" title={ONBOARDING_COPY.placementBeginner} onPress={() => startWithPack(null)} />
        {PLACEMENT_LEVELS.map((level) => (
          <Choice key={level} role="button" title={level} onPress={() => startWithPack(level)} />
        ))}
      </RiseIn>
    );
  } else {
    body = (
      <RiseIn key="first" duration={300}>
        {title(ONBOARDING_COPY.firstTitle)}
        {note('Bring cards from Anki or a file, or make your own.')}
        {firstChoice ? <Choice role="button" title={firstChoice.title} sub={firstChoice.sub} onPress={onPackChoice} /> : null}
        {FIRST_CARDS_CHOICES.filter((choice) => choice.action !== 'later').map((choice) => (
          <Choice key={choice.action} role="button" title={choice.title} sub={choice.sub} onPress={() => startAction(choice)} />
        ))}
      </RiseIn>
    );
    const later = FIRST_CARDS_CHOICES.find((choice) => choice.action === 'later')!;
    footer = (
      <Btn full kind="ghost" onPress={() => startAction(later)}>
        {later.title}
      </Btn>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      {/* progress + skip */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: insets.top + 8,
          paddingHorizontal: 20,
        }}
      >
        <View
          accessible
          accessibilityLabel={`Step ${stepIndex + 1} of ${steps.length}`}
          style={{ flexDirection: 'row', gap: 6 }}
        >
          {steps.map((s, i) => (
            <View
              key={s}
              style={{
                width: i === stepIndex ? 22 : 7,
                height: 7,
                borderRadius: 99,
                backgroundColor: i <= stepIndex ? c.pine : c.hairlineStrong,
              }}
            />
          ))}
        </View>
        {step !== 'first' && !adding ? (
          <Pressable onPress={skip} hitSlop={12} accessibilityRole="button">
            <Text style={[font('sans', 700), { fontSize: 14, color: c.ink3 }]}>{ONBOARDING_COPY.skip}</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
        // A tap on a choice works at once, even while a keyboard is open (wave 5b M3).
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>

      {footer && !adding ? (
        <View style={{ paddingHorizontal: 22, paddingTop: 14, paddingBottom: insets.bottom + 30 }}>{footer}</View>
      ) : (
        <View style={{ height: insets.bottom + 30 }} />
      )}

      {/* The global snackbar, shown over the tour (see the file comment). */}
      <SnackbarHost aboveTabBar={false} />
    </View>
  );
}

/** The three values a pace writes. */
function pick3(v: { dailyNewLimit: number; goalReviews: number; goalNew: number }) {
  return { dailyNewLimit: v.dailyNewLimit, goalReviews: v.goalReviews, goalNew: v.goalNew };
}
