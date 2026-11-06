/**
 * Settings hub (spec §8.6, unit W4-5) — the root of the Settings stack.
 *
 *   Settings
 *   (🔍 Search settings…)
 *   APPEARANCE    (Paper | Evening | System)
 *   STUDY         Study & limits   10 new · 200 reviews a day · sessions of 30 · Flashcards  ›
 *                 Reminders        On · 8:00 PM · next: today 8:00 PM                         ›
 *   AUDIO & FEEL  Read-aloud button [toggle] · Speak the question automatically [toggle]
 *                 Haptics [toggle] · Streak freezes  2 available · earn one every 7 days (?)
 *   YOUR DATA     Import · Export · Restore · History                                        ›
 *   ADVANCED      Algorithm (SM-2 settings)                                                  ›
 *   HELP          Help & FAQ ›   Replay the tour ›
 *   DANGER ZONE   Reset preferences · Erase everything
 *   Maranki 3.0.0          ← "Maranki German 3.0.0" in the German build (appFooterLine)
 *
 * The drill-ins are real routes (settings/_layout.tsx), so Android's back
 * closes them. The search (SettingsSearch.tsx) filters the hub's own rows in
 * place and lists the matching rows of the other pages.
 *
 * The Reminders row reads the system permission too (useNotificationsAllowed):
 * when the reminder is on but notifications are blocked, it says "On ·
 * notifications are turned off" instead of promising a "next" reminder that
 * the phone will never show (review round 1).
 *
 * Danger zone:
 *   - "Reset preferences" asks first, then `resetPreferences()` (settings back
 *     to defaults) and the daily goals back to the first-run goals. Data is
 *     not touched. The confirm text (settingsIndex.ts RESET_COPY.body) names
 *     everything that goes back to its default.
 *   - "Erase everything" opens the Erase sheet: what goes (with plural()),
 *     "Export a backup first" (a real backup, kept on this phone and shared;
 *     then "Backup saved ✓"), and a 1-second hold. After the hold:
 *     `factoryReset()`, then `actions.flush()`: the snackbar says "erased"
 *     ONLY when that save committed (W2 hardening leftover).
 *     While the backup is being saved, the hold is OFF and the sheet stays
 *     open (`eraseSheetControls`, review round 2): the learner sees the
 *     backup's result BEFORE anything can be erased.
 *
 * Largest font size (device pass 2026-11-02, F1-3 / F1-6): the rows wrap
 * (the kit's ListRow never cuts a title or a sub), and a solid strip under
 * the status bar (StatusBarStrip) keeps the page from scrolling under the
 * clock.
 */
import Constants from 'expo-constants';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import React, { useMemo, useRef, useState } from 'react';
import { Keyboard, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NoSettingsMatch, SettingsSearchBox, SettingsSearchResults, drillInMatches } from '@/components/settings/SettingsSearch';
import {
  appFooterLine,
  ERASE_COPY,
  eraseConsequences,
  type EraseExportState,
  eraseResultMessage,
  eraseSheetControls,
  freezesLabel,
  freezesLine,
  matchesSetting,
  noSettingsMatch,
  PAGE_ROUTE,
  RESET_COPY,
  SETTINGS_INDEX,
  type SettingsId,
  studySummary,
} from '@/components/settings/settingsIndex';
import { InfoButton } from '@/components/sheets/InfoButton';
import {
  A11Y_HIDDEN,
  Btn,
  HoldButton,
  Ion,
  ListRow,
  Pill,
  ScreenHead,
  SectionHead,
  SegCtrl,
  Sheet,
  Toggle,
} from '@/components/ui';
import { StatusBarStrip } from '@/components/ui/layout';
import { levelInfo } from '@/domain/gamification';
import { buildSeedState } from '@/domain/seed';
import { exportAndKeepBackup, fullBackupIO, keptExportMessage } from '@/store/backup';
import { useData } from '@/store/DataContext';
import { reminderRowSub, useNotificationsAllowed } from '@/store/reminderSync';
import { useSnackbar } from '@/store/SnackbarContext';
import { appRevlogStore } from '@/store/storage';
import { useNow } from '@/store/useNow';
import { font, TABBAR_HEIGHT, tnum } from '@/theme/tokens';
import { useColors, useTheme } from '@/theme/ThemeContext';

/** The hub's own rows, by id (the search filters them in place). */
const ENTRY = new Map(SETTINGS_INDEX.map((e) => [e.id, e]));

/** True when the hub row `id` matches the search (an empty search shows everything). */
function shows(id: SettingsId, query: string): boolean {
  const entry = ENTRY.get(id);
  return entry ? matchesSetting(entry, query) : query.trim() === '';
}

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const now = useNow();
  const { mode, setMode } = useTheme();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const s = state.settings;
  // Does the system allow our notifications? Read again each time the hub is
  // shown (the user may have just turned reminders on in Settings › Reminders).
  const { allowed: notificationsAllowed, refresh: refreshPermission } = useNotificationsAllowed();
  useFocusEffect(refreshPermission);

  const [q, setQ] = useState('');
  const searching = q.trim() !== '';
  const [resetOpen, setResetOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  // The Erase sheet's "Export a backup first": idle → busy → done (or failed).
  const [eraseExport, setEraseExport] = useState<EraseExportState>('idle');
  // The line under that button (the sheet is a modal: the snackbar is hidden behind it).
  const [eraseNote, setEraseNote] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);
  // True while the backup is being saved. A ref, because the hold's
  // `onConfirm` and the sheet's callbacks can be from an older render (a hold
  // that started BEFORE the export tap still ends in `erase()`); they must see
  // the export that runs now. Written and read only in handlers, never in render.
  const exportRunning = useRef(false);
  const eraseControls = eraseSheetControls(eraseExport, erasing);

  const consequences = useMemo(
    () =>
      eraseConsequences({
        decks: state.decks.length,
        cards: state.cards.length,
        sessions: state.sessions.length,
        streak: state.person.streak,
        level: levelInfo(state.person.xp).level,
      }),
    [state.decks.length, state.cards.length, state.sessions.length, state.person.streak, state.person.xp],
  );

  /**
   * Close the search keyboard, then do `action` (open a page or a sheet). The
   * hub keeps taps while the keyboard is open (keyboardShouldPersistTaps,
   * wave 5b M3), so a row that leaves the hub closes the keyboard itself.
   */
  const leaving = (action: () => void) => () => {
    Keyboard.dismiss();
    action();
  };

  /** Open a drill-in page (a path of the Settings stack; typed routes may not list it yet). */
  const open = (page: keyof typeof PAGE_ROUTE) => leaving(() => router.push(PAGE_ROUTE[page] as Href))();

  const exportBeforeErase = async () => {
    if (exportRunning.current) return;
    exportRunning.current = true;
    setEraseExport('busy');
    setEraseNote(null);
    // The backup is KEPT on this phone first, so "Backup saved ✓" is true
    // whatever happens in the share sheet (src/store/backup.ts). It never rejects.
    const outcome = await exportAndKeepBackup(state, Date.now(), fullBackupIO(appRevlogStore()), {
      images: s.backupImages,
    });
    exportRunning.current = false;
    setEraseExport(outcome.kind === 'kept' ? 'done' : 'failed');
    setEraseNote(keptExportMessage(outcome));
  };

  /** Close the Erase sheet — but never while its backup is being saved (its result must be seen). */
  const closeErase = () => {
    if (exportRunning.current) return;
    setEraseOpen(false);
  };

  const erase = async () => {
    // Never while the backup is being saved (see `exportRunning`).
    if (erasing || exportRunning.current) return;
    setErasing(true);
    setEraseOpen(false);
    actions.factoryReset();
    // "Erased" only when the replace-all committed.
    const saved = await actions.flush();
    setErasing(false);
    show(eraseResultMessage(saved));
  };

  const resetPreferences = () => {
    setResetOpen(false);
    actions.resetPreferences();
    // The goals are preferences too: back to the first-run goals (a goal never writes a limit).
    const seed = buildSeedState(Date.now()).person;
    actions.setGoals(seed.goalReviews, seed.goalNew);
    show(RESET_COPY.done);
  };

  const hubMatches = SETTINGS_INDEX.some((e) => e.page === 'index' && matchesSetting(e, q));
  const nothing = searching && !hubMatches && drillInMatches(q).length === 0;

  const audioRows = (['readAloud', 'autoReadAloud', 'haptics', 'freezes'] as const).filter((id) => shows(id, q));
  const helpRows = (['help', 'tour'] as const).filter((id) => shows(id, q));
  const dangerRows = (['resetPreferences', 'erase'] as const).filter((id) => shows(id, q));

  return (
    <>
      {/* The UI kit's `Page`, plus keyboardShouldPersistTaps (wave 5b M3): while
          the search keyboard is open, the FIRST tap on a result (a toggle, a
          row of another page) works. Without it, that tap only closed the
          keyboard and the learner had to tap again. */}
      <ScrollView
        style={{ flex: 1, backgroundColor: c.paper }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: TABBAR_HEIGHT + insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <ScreenHead title="Settings" />
        <SettingsSearchBox value={q} onChange={setQ} />

        {shows('appearance', q) ? (
          <View>
            <SectionHead>Appearance</SectionHead>
            <SegCtrl
              label="Appearance"
              value={mode}
              onChange={(id) => setMode(id as typeof mode)}
              options={[
                { id: 'light', label: 'Paper', icon: 'sunny-outline' },
                { id: 'dark', label: 'Evening', icon: 'moon-outline' },
                { id: 'system', label: 'System', icon: 'phone-portrait-outline' },
              ]}
            />
          </View>
        ) : null}

        {!searching ? (
          <View>
            <SectionHead>Study</SectionHead>
            <ListRow icon="school-outline" title="Study & limits" sub={studySummary(s)} onPress={() => open('study')} />
            <ListRow
              icon="notifications-outline"
              title="Reminders"
              sub={reminderRowSub(state, now, notificationsAllowed)}
              last
              onPress={() => open('reminders')}
            />
          </View>
        ) : null}

        {audioRows.length > 0 ? (
          <View>
            <SectionHead>Audio & feel</SectionHead>
            {audioRows.map((id, i) => {
              const last = i === audioRows.length - 1;
              if (id === 'readAloud') {
                return (
                  <ListRow
                    key={id}
                    icon="volume-high-outline"
                    title="Read-aloud button"
                    sub="Show the speaker on every card"
                    last={last}
                    right={
                      <Toggle
                        on={s.readAloudEnabled}
                        label="Read-aloud button"
                        onChange={(v) => actions.updateAppSettings({ readAloudEnabled: v })}
                      />
                    }
                  />
                );
              }
              if (id === 'autoReadAloud') {
                return (
                  <ListRow
                    key={id}
                    icon="mic-outline"
                    title="Speak the question automatically"
                    sub="Reads each card aloud when it appears"
                    last={last}
                    right={
                      <Toggle
                        on={s.autoReadAloud}
                        label="Speak the question automatically"
                        onChange={(v) => actions.updateAppSettings({ autoReadAloud: v })}
                      />
                    }
                  />
                );
              }
              if (id === 'haptics') {
                return (
                  <ListRow
                    key={id}
                    icon="phone-portrait-outline"
                    title="Haptics"
                    sub="A small vibration when you reveal and rate"
                    last={last}
                    right={
                      <Toggle
                        on={s.hapticsEnabled}
                        label="Haptics"
                        onChange={(v) => actions.updateAppSettings({ hapticsEnabled: v })}
                      />
                    }
                  />
                );
              }
              return (
                <ListRow
                  key={id}
                  icon="snow-outline"
                  iconColor={c.info}
                  iconBg={c.infoTint}
                  title="Streak freezes"
                  sub={freezesLine(state.person.freezes)}
                  last={last}
                  right={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Pill mono label={freezesLabel(state.person.freezes)}>
                        {state.person.freezes}
                      </Pill>
                      <InfoButton term="Freeze" />
                    </View>
                  }
                />
              );
            })}
          </View>
        ) : null}

        {!searching ? (
          <View>
            <SectionHead>Your data</SectionHead>
            <ListRow
              icon="folder-open-outline"
              title="Import · Export · Restore · History"
              sub="Backups on this phone and your study history"
              last
              onPress={() => open('data')}
            />
            <SectionHead>Advanced</SectionHead>
            <ListRow
              icon="options-outline"
              iconColor={c.warning}
              iconBg={c.warningTint}
              title="Algorithm (SM-2 settings)"
              sub="Learning steps, intervals and ease"
              last
              onPress={() => open('algorithm')}
            />
          </View>
        ) : null}

        {helpRows.length > 0 ? (
          <View>
            <SectionHead>Help</SectionHead>
            {helpRows.map((id, i) =>
              id === 'help' ? (
                <ListRow
                  key={id}
                  icon="help-buoy-outline"
                  title="Help & FAQ"
                  sub="How Maranki works, offline"
                  last={i === helpRows.length - 1}
                  // The Help route is added by another unit of this wave.
                  onPress={leaving(() => router.push('/help'))}
                />
              ) : (
                <ListRow
                  key={id}
                  icon="play-circle-outline"
                  title="Replay the tour"
                  sub="Your current settings stay unless you change them"
                  last={i === helpRows.length - 1}
                  // The tour with every step pre-filled; it writes only what you change.
                  onPress={leaving(() => router.push('/onboarding?replay=1'))}
                />
              ),
            )}
          </View>
        ) : null}

        {searching ? <SettingsSearchResults query={q} /> : null}
        {nothing ? <NoSettingsMatch text={noSettingsMatch(q)} /> : null}

        {dangerRows.length > 0 ? (
          <View>
            <SectionHead>Danger zone</SectionHead>
            <View
              style={{
                borderWidth: 1,
                borderColor: c.danger + '4D',
                borderRadius: 14,
                paddingVertical: 2,
                paddingHorizontal: 14,
                backgroundColor: c.danger + '0A',
              }}
            >
              {dangerRows.map((id, i) =>
                id === 'resetPreferences' ? (
                  <ListRow
                    key={id}
                    icon="refresh-outline"
                    danger
                    title="Reset preferences"
                    sub="Keeps every card, deck, streak and session"
                    last={i === dangerRows.length - 1}
                    onPress={leaving(() => setResetOpen(true))}
                  />
                ) : (
                  <ListRow
                    key={id}
                    icon="trash-outline"
                    danger
                    title="Erase everything"
                    sub="Deletes all decks, cards, progress and settings"
                    last={i === dangerRows.length - 1}
                    onPress={leaving(() => setEraseOpen(true))}
                  />
                ),
              )}
            </View>
          </View>
        ) : null}

        <Text
          style={[
            font('mono', 400),
            { fontSize: 11.5, color: c.ink3, textAlign: 'center', paddingTop: 26, paddingBottom: 4 },
          ]}
        >
          {/* "Maranki 3.0.0" / "Maranki German 3.0.0": the human name of the build, never "generic". */}
          {appFooterLine(Constants.expoConfig)}
        </Text>

        {/* Reset preferences: say what changes, then confirm. */}
        <Sheet open={resetOpen} onClose={() => setResetOpen(false)} title={RESET_COPY.title}>
          <Text style={[font('sans', 400), { fontSize: 14.5, lineHeight: 21, color: c.ink2, marginBottom: 18 }]}>
            {RESET_COPY.body}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setResetOpen(false)}>
              {RESET_COPY.cancel}
            </Btn>
            <Btn kind="dangerSolid" full style={{ flex: 1 }} onPress={resetPreferences}>
              {RESET_COPY.confirm}
            </Btn>
          </View>
        </Sheet>

        {/* Erase everything: what goes, a real backup first, then a 1-second hold. */}
        <Sheet
          open={eraseOpen}
          onClose={closeErase}
          onClosed={() => {
            setEraseExport('idle');
            setEraseNote(null);
          }}
          title={ERASE_COPY.title}
        >
          <Text style={[font('sans', 400), { fontSize: 14, lineHeight: 21, color: c.ink2, marginBottom: 12 }]}>
            {ERASE_COPY.intro}
          </Text>
          <View
            style={{
              backgroundColor: c.dangerTint,
              borderRadius: 14,
              paddingVertical: 13,
              paddingHorizontal: 16,
              marginBottom: 16,
            }}
          >
            {consequences.map((line) => (
              <View key={line} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 4 }}>
                <View {...A11Y_HIDDEN}>
                  <Ion name="close-circle" size={15} color={c.danger} />
                </View>
                <Text style={[font('sans', 400), tnum, { flex: 1, fontSize: 13.5, color: c.danger }]}>{line}</Text>
              </View>
            ))}
          </View>
          <Btn
            kind="secondary"
            full
            icon={eraseExport === 'done' ? undefined : 'share-outline'}
            disabled={eraseExport === 'busy'}
            style={{ marginBottom: eraseNote ? 6 : 10 }}
            onPress={() => void exportBeforeErase()}
          >
            {eraseExport === 'done' ? ERASE_COPY.saved : eraseExport === 'busy' ? ERASE_COPY.exporting : ERASE_COPY.exportFirst}
          </Btn>
          {eraseNote ? (
            <Text
              style={[
                font('sans', 400),
                { fontSize: 12.5, lineHeight: 18, color: eraseExport === 'failed' ? c.danger : c.ink3, marginBottom: 10 },
              ]}
            >
              {eraseNote}
            </Text>
          ) : null}
          {/* Off while the backup is being saved: export → "Backup saved ✓" → then the hold (spec §8.6). */}
          <HoldButton
            kind="dangerSolid"
            icon="trash-outline"
            disabled={eraseControls.holdDisabled}
            onConfirm={() => void erase()}
          >
            {ERASE_COPY.hold}
          </HoldButton>
          {/* Visible, not only the screen-reader hint: a tap alone does nothing. */}
          <Text
            importantForAccessibility="no"
            accessibilityElementsHidden
            style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink2, textAlign: 'center', marginTop: 6 }]}
          >
            {ERASE_COPY.holdNote}
          </Text>
          <Btn kind="quiet" full disabled={eraseControls.keepOpen} style={{ marginTop: 8 }} onPress={closeErase}>
            {ERASE_COPY.cancel}
          </Btn>
        </Sheet>
      </ScrollView>
      {/* After the page, so it is drawn on top: the page scrolls under it, not under the clock. */}
      <StatusBarStrip />
    </>
  );
}
