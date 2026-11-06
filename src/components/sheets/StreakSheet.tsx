/**
 * Streak sheet (C2) — freezes visible, explained, earnable. Opened from
 * Today's streak chip (spec §2.3). The 14-day strip comes from the real
 * session history and the days a freeze was used; blue = saved by a freeze.
 * Reassuring, never alarming.
 *
 * Fixed in unit W4-1 (spec §7 #31, §8.11): the green line said "1 freeze
 * used" whatever happened. It now counts the freezes really used in the last
 * 14 days (todayLogic.ts `freezesUsedRecently`), and every count uses
 * plural() ("1 day", never "1 days").
 */
import React, { useMemo } from 'react';
import { Text, View } from 'react-native';

import { A11Y_HIDDEN, Ion, Sheet } from '@/components/ui';
import {
  type DayMark,
  freezesUsedLine,
  freezesUsedRecently,
  STREAK_STRIP_DAYS,
  streakStrip,
  streakUnit,
} from '@/components/today/todayLogic';
import type { DataStateV3 } from '@/domain/model';
import { plural } from '@/domain/text';
import { useStateV3 } from '@/store/selectors';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

const personOf = (s: DataStateV3) => s.person;
const sessionsOf = (s: DataStateV3) => s.sessions;

export function StreakSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = useColors();
  const person = useStateV3(personOf);
  const sessions = useStateV3(sessionsOf);
  const now = useNow();

  const days: DayMark[] = useMemo(
    () => streakStrip(sessions, person.freezeUsedDays, now),
    [sessions, person.freezeUsedDays, now],
  );
  const usedRecently = freezesUsedRecently(person.freezeUsedDays, now);
  const studiedDays = days.filter((d) => d === 'studied').length;
  const savedDays = days.filter((d) => d === 'frozen').length;

  const dotStyle = (d: DayMark) =>
    ({
      studied: { bg: c.amber, icon: null as string | null },
      frozen: { bg: c.infoTint, icon: 'snow' },
      missed: { bg: c.paperSunk, icon: null },
      today: { bg: c.pine, icon: null },
    })[d];

  return (
    <Sheet open={open} onClose={onClose} title="Your streak">
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text
          style={[font('sans', 800), tnum, { fontSize: 44, color: c.ink, letterSpacing: -1.3 }]}
        >
          {person.streak.toLocaleString('en-US')}
        </Text>
        <Text style={[font('serif', 400, true), { fontSize: 19, color: c.ink2 }]}>
          {streakUnit(person.streak)}
        </Text>
      </View>
      <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink3, marginTop: 2, marginBottom: 16 }]}>
        Best: {plural(person.bestStreak, 'day')}
      </Text>

      {/* The strip is a picture; the label says the same in words. */}
      <View
        accessible
        accessibilityLabel={`Last ${STREAK_STRIP_DAYS} days: studied on ${plural(studiedDays, 'day')}, ${plural(savedDays, 'day')} saved by a freeze`}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 8 }}
      >
        {days.map((d, i) => {
          const m = dotStyle(d);
          return (
            <View
              key={i}
              {...A11Y_HIDDEN}
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                backgroundColor: m.bg,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: d === 'today' ? 2 : 0,
                borderColor: d === 'today' ? c.pineDeep : undefined,
              }}
            >
              {m.icon ? <Ion name={m.icon} size={12} color={c.info} /> : null}
            </View>
          );
        })}
      </View>
      <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginBottom: 18 }]}>
        Last {STREAK_STRIP_DAYS} days · blue = saved by a freeze
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: c.infoTint,
          borderRadius: 14,
          paddingVertical: 13,
          paddingHorizontal: 15,
        }}
      >
        <View {...A11Y_HIDDEN}>
          <Ion name="snow" size={20} color={c.info} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[font('sans', 700), { fontSize: 14, color: c.ink }]}>
            {plural(person.freezes, 'streak freeze')}
          </Text>
          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink2 }]}>
            A freeze bridges one missed day. Earn one at every 7-day milestone.
          </Text>
        </View>
      </View>

      {usedRecently > 0 && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginTop: 12,
            paddingVertical: 11,
            paddingHorizontal: 15,
            backgroundColor: c.successTint,
            borderRadius: 14,
          }}
        >
          <View {...A11Y_HIDDEN}>
            <Ion name="shield-checkmark" size={18} color={c.success} />
          </View>
          <Text style={[font('sans', 400), { flex: 1, fontSize: 13, color: c.ink }]}>
            {freezesUsedLine(usedRecently)}
          </Text>
        </View>
      )}
    </Sheet>
  );
}
