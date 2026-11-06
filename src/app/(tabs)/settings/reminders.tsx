/**
 * Settings › Reminders (spec §8.7, unit W4-5).
 *
 *   ‹ Reminders
 *   Daily reminder                              [toggle]
 *   Time                                        8:00 PM ›
 *   Skip days when I already studied            [toggle]
 *   Next reminder: today at 8:00 PM
 *   Reminders may arrive up to an hour late. Android holds them back to save battery.
 *   Reminders not arriving? ›
 *
 * The delay line is the truth (release pass 2026-11-02, C1-1): Android
 * schedules the reminders as INEXACT alarms, so one can come up to an hour
 * after the chosen time (see src/platform/notifications.ts `scheduleDates`).
 * We do not ask for the exact-alarm permission: a daily study reminder does
 * not need to be exact, and that permission is meant for alarm clocks.
 *
 * Real local notifications (expo-notifications): up to 14 one-shot dates at
 * the chosen time, skipping a day you already studied — planned by
 * src/platform/reminderPlan.ts and scheduled by src/store/reminderSync.ts.
 *
 * Turning on runs the permission flow (`enableReminders`): the Android
 * channel FIRST (Android 13 shows the prompt only after a channel exists),
 * then the prompt only when needed. Denied → the toggle stays off, and the
 * screen says "Notifications are turned off for Maranki." with
 * "Open system settings" (`Linking.openSettings()`).
 *
 * On, but the system never allowed it (a backup restored on a new phone):
 * the same box, with "Allow notifications" first — it runs the same
 * permission flow, so the normal system prompt shows when the system still
 * lets us ask (`reminderBlock`, review round 2). After a refused try, only
 * "Open system settings" stays.
 *
 * `?enable=1` (cross-unit contract): Today's "Want a daily reminder?" card
 * opens `/(tabs)/settings/reminders?enable=1`, and this screen then runs the
 * permission flow once, at open. The param is cleared right away, so a
 * re-render or "back" never asks again. When the Settings stack was not
 * mounted yet, that link alone makes the stack `[reminders]`; the Settings
 * layout then puts the hub under this page (settings/_layout.tsx), without
 * mounting this page again — so "back" lands on the hub.
 *
 * When the user comes back from the system settings (the app becomes
 * active), the permission is read again and the reminders are planned again.
 */
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native';

import { PAGE_TITLE } from '@/components/settings/settingsIndex';
import { A11Y_HIDDEN, Btn, Ion, Page, Row, StackBar, Toggle } from '@/components/ui';
import { useData } from '@/store/DataContext';
import {
  deviceReminderPort,
  enableReminders,
  formatReminderTime,
  REMINDER_COPY,
  reminderBlock,
  reminderPickerValue,
  reminderStatusLine,
  reminderTimeOf,
  syncReminders,
} from '@/store/reminderSync';
import { useEngine } from '@/store/selectors';
import { useSnackbar } from '@/store/SnackbarContext';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** What the system says about notifications for this app. */
type Permission = 'unknown' | 'allowed' | 'denied';

export default function RemindersScreen() {
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const engine = useEngine();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const s = state.settings;
  const params = useLocalSearchParams<{ enable?: string }>();

  const [permission, setPermission] = useState<Permission>('unknown');
  // True after a "turn on" (or "Allow notifications") that the user (or the system) denied.
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Android: the time dialog is open (it opens when it mounts, closes when it unmounts).
  const [picking, setPicking] = useState(false);

  /** What the system said about notifications (called from a promise callback, never during render). */
  const applyPermission = useCallback((allowed: boolean) => {
    setPermission(allowed ? 'allowed' : 'denied');
    if (allowed) setDenied(false);
  }, []);

  /** Plan the reminders again for the newest state; say so only when it failed. */
  const resync = useCallback(async () => {
    const result = await syncReminders(engine.store.getState(), Date.now());
    if (result.kind === 'failed') show(REMINDER_COPY.syncFailed);
  }, [engine, show]);

  /** The permission flow, then "on" (see the file comment). Starts with an await: no state change before it. */
  const runTurnOn = useCallback(async () => {
    const outcome = await enableReminders({
      updateAppSettings: actions.updateAppSettings,
      getState: () => engine.store.getState(),
      now: () => Date.now(),
    });
    setBusy(false);
    if (outcome.kind === 'denied') {
      setDenied(true);
      setPermission('denied');
      return;
    }
    if (outcome.kind === 'failed') {
      show(REMINDER_COPY.failed);
      return;
    }
    setDenied(false);
    setPermission('allowed');
    if (outcome.sync.kind === 'failed') show(REMINDER_COPY.syncFailed);
  }, [actions, engine, show]);

  // The permission now, and again whenever the app comes back (from the system settings).
  useEffect(() => {
    let alive = true;
    // Read the permission (never asks); the answer arrives in a callback.
    const read = () =>
      deviceReminderPort
        .hasPermission()
        .catch(() => false)
        .then((allowed) => {
          if (alive) applyPermission(allowed);
        });
    void read();
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void read();
      void resync();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [applyPermission, resync]);

  // `?enable=1`: run the permission flow once, at open (Today's reminder offer).
  // The ref stops a second run for the SAME request (React may run an effect
  // twice in development); it is cleared once the param is gone, so a later
  // request (Today's card again) runs the flow again.
  const enableHandled = useRef(false);
  useEffect(() => {
    if (params.enable !== '1') {
      enableHandled.current = false;
      return;
    }
    if (enableHandled.current) return;
    enableHandled.current = true;
    router.setParams({ enable: undefined });
    void runTurnOn();
  }, [params.enable, router, runTurnOn]);

  /** "Daily reminder" on, or "Allow notifications": the permission flow (one at a time). */
  const startTurnOn = () => {
    if (busy) return;
    setBusy(true);
    void runTurnOn();
  };

  const onToggle = (on: boolean) => {
    if (busy) return;
    if (on) {
      startTurnOn();
      return;
    }
    actions.updateAppSettings({ reminderEnabled: false });
    void resync();
  };

  const pickTime = (date: Date | null | undefined) => {
    setPicking(false);
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
    const time = reminderTimeOf(date);
    if (time === s.reminderTime) return;
    actions.updateAppSettings({ reminderTime: time });
    void resync();
  };

  const onSkip = (on: boolean) => {
    actions.updateAppSettings({ reminderSkipStudied: on });
    void resync();
  };

  const timeLabel = formatReminderTime(s.reminderTime);
  // On, but the system does not deliver: say it, offer to ask (when that can
  // still work) and the system settings.
  const block = reminderBlock({
    enabled: s.reminderEnabled,
    allowed: permission === 'unknown' ? null : permission === 'allowed',
    refused: denied,
  });
  const os = Platform.OS;

  const label = (text: string, sub?: string) => (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink }]}>{text}</Text>
      {sub ? <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>{sub}</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title={PAGE_TITLE.reminders} onBack={() => router.back()} />
      <Page pad={20}>
        <View style={{ height: 10 }} />
        <Row padV={12}>
          {label(REMINDER_COPY.toggle)}
          <Toggle on={s.reminderEnabled} label={REMINDER_COPY.toggle} disabled={busy} onChange={onToggle} />
        </Row>

        {/* Time: Android = a Material dialog; iOS = the compact picker in the row; web preview = text only. */}
        {os === 'ios' ? (
          <Row padV={10}>
            {label(REMINDER_COPY.time)}
            <DateTimePicker
              mode="time"
              display="compact"
              value={reminderPickerValue(s.reminderTime, now)}
              accentColor={c.pine}
              onValueChange={(_event, date) => pickTime(date)}
            />
          </Row>
        ) : (
          <Row
            padV={12}
            onPress={os === 'android' ? () => setPicking(true) : undefined}
            label={`${REMINDER_COPY.time} ${timeLabel}`}
            hint={os === 'android' ? 'Opens the time picker' : undefined}
          >
            {label(REMINDER_COPY.time)}
            <Text style={[font('sans', 700), tnum, { fontSize: 14.5, color: c.ink }]}>{timeLabel}</Text>
            {os === 'android' ? (
              <View {...A11Y_HIDDEN}>
                <Ion name="chevron-forward" size={16} color={c.ink3} />
              </View>
            ) : null}
          </Row>
        )}
        {os === 'android' && picking ? (
          <DateTimePicker
            mode="time"
            presentation="dialog"
            is24Hour={false}
            value={reminderPickerValue(s.reminderTime, now)}
            accentColor={c.pine}
            onValueChange={(_event, date) => pickTime(date)}
            onDismiss={() => setPicking(false)}
          />
        ) : null}

        <Row padV={12} last>
          {label(REMINDER_COPY.skip)}
          <Toggle on={s.reminderSkipStudied} label={REMINDER_COPY.skip} onChange={onSkip} />
        </Row>

        {block ? (
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
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <View {...A11Y_HIDDEN}>
                <Ion name="notifications-off-outline" size={17} color={c.warning} style={{ marginTop: 1 }} />
              </View>
              <Text style={[font('sans', 400), { flex: 1, fontSize: 13.5, lineHeight: 20, color: c.ink }]}>
                {REMINDER_COPY.denied}
              </Text>
            </View>
            {block.canAsk ? (
              <Btn kind="primary" size="sm" icon="notifications-outline" disabled={busy} onPress={startTurnOn}>
                {REMINDER_COPY.allow}
              </Btn>
            ) : null}
            <Btn kind="secondary" size="sm" icon="settings-outline" onPress={() => void Linking.openSettings()}>
              {REMINDER_COPY.openSettings}
            </Btn>
          </View>
        ) : (
          <Text
            accessibilityLiveRegion="polite"
            style={[font('sans', 700), tnum, { fontSize: 14, color: s.reminderEnabled ? c.pine : c.ink3, marginTop: 16 }]}
          >
            {reminderStatusLine(state, now)}
          </Text>
        )}

        <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 14 }]}>
          {REMINDER_COPY.late}
        </Text>
        <Pressable
          onPress={() => router.push('/help?topic=reminders')}
          accessibilityRole="button"
          hitSlop={12}
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
        >
          <Text style={[font('sans', 700), { fontSize: 13, color: c.pine }]}>Reminders not arriving?</Text>
        </Pressable>
      </Page>
    </View>
  );
}
