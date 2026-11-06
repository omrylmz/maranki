/**
 * Today's one-time cards (spec §8.1, unit W4-1). Each one can be closed, and
 * at most one shows at a time (todayLogic.ts `pickOneTimeCard`):
 *
 *   1. "We fixed {n} items in your library."   — the last boot repaired data
 *      (checkIntegrity, spec §3.5). The number is the boot result's
 *      `repaired` list. Closing it hides it for this run of the app; the
 *      repaired data is saved, so the next boot has nothing to report.
 *   2. "Want a daily reminder?" · "Remind me at 8:00 PM" · "Not now"
 *      — after the first completed session, while reminders are off. Both
 *      buttons set `settings.reminderOfferSeen`, so it shows only once.
 *      "Remind me at …" opens Settings › Reminders with `enable=1`; THAT
 *      screen runs the permission flow and schedules (src/store/reminderSync.ts,
 *      unit W4-5). Today never schedules a notification itself.
 *
 * Where the repair count comes from: `engine.boot()` returns the SAME promise
 * on every call, so after a successful boot it hands out the boot result
 * again without loading anything. It is read only when the persistence
 * status is 'ready' (a blocked boot never shows Today: the root layout shows
 * the DataProblemScreen instead), so this never starts a boot or a retry.
 */
import { type Href, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { A11Y_HIDDEN, Btn, IconBtn, Ion } from '@/components/ui';
import type { DataStateV3 } from '@/domain/model';
import { useEngine, useEngineMeta, useStateV3 } from '@/store/selectors';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  type OneTimeCardKind,
  pickOneTimeCard,
  REMINDER_OFFER_COPY,
  REMINDER_OFFER_HREF,
  reminderOfferButton,
  repairsLine,
} from './todayLogic';

/**
 * How many items the boot of this engine repaired (0 until it is known).
 * Reads the boot result after the boot reached 'ready'.
 */
export function useBootRepairs(): number {
  const engine = useEngine();
  const { ready } = useEngineMeta();
  const [repairs, setRepairs] = useState(0);
  useEffect(() => {
    // Only a boot that finished and is not blocked: then boot() is the cached promise.
    if (!ready || engine.status !== 'ready') return;
    let live = true;
    engine
      .boot()
      .then((result) => {
        if (live && result.kind === 'loaded') setRepairs(result.repaired.length);
      })
      .catch(() => {
        // The engine was disposed (the provider is gone): nothing to show.
      });
    return () => {
      live = false;
    };
  }, [engine, ready]);
  return repairs;
}

/** What the reminder offer reads. */
const offerInputsOf = (s: DataStateV3) => s.settings;
const sessionCountOf = (s: DataStateV3) => s.sessions.length;

export function OneTimeCards() {
  const c = useColors();
  const router = useRouter();
  const { actions } = useEngine();
  const repairs = useBootRepairs();
  const settings = useStateV3(offerInputsOf);
  const sessions = useStateV3(sessionCountOf);
  const [repairsDismissed, setRepairsDismissed] = useState(false);

  const kind: OneTimeCardKind | null = pickOneTimeCard({
    repairs,
    repairsDismissed,
    sessions,
    reminderEnabled: settings.reminderEnabled,
    reminderOfferSeen: settings.reminderOfferSeen,
  });
  if (!kind) return null;

  const box = {
    marginTop: 22,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
  } as const;

  if (kind === 'repairs') {
    return (
      <View style={[box, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
        <View {...A11Y_HIDDEN}>
          <Ion name="construct-outline" size={20} color={c.success} />
        </View>
        <Text style={[font('sans', 600), { flex: 1, fontSize: 14, color: c.ink, lineHeight: 20 }]}>
          {repairsLine(repairs)}
        </Text>
        <IconBtn icon="close" size={32} iconSize={17} label="Close this message" onPress={() => setRepairsDismissed(true)} />
      </View>
    );
  }

  const seen = () => actions.updateAppSettings({ reminderOfferSeen: true });
  return (
    <View style={box}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View {...A11Y_HIDDEN}>
          <Ion name="notifications-outline" size={20} color={c.pine} />
        </View>
        <Text accessibilityRole="header" style={[font('serif', 600), { flex: 1, fontSize: 18, color: c.ink }]}>
          {REMINDER_OFFER_COPY.title}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        <Btn
          size="sm"
          icon="alarm-outline"
          onPress={() => {
            seen();
            // Settings › Reminders (unit W4-5) runs the permission flow when it opens with enable=1.
            router.push(REMINDER_OFFER_HREF as Href);
          }}
        >
          {reminderOfferButton(settings.reminderTime)}
        </Btn>
        <Btn size="sm" kind="quiet" onPress={seen}>
          {REMINDER_OFFER_COPY.notNow}
        </Btn>
      </View>
    </View>
  );
}
