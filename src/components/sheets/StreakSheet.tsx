/**
 * Streak sheet (C2) — freezes visible, explained, earnable. The 14-day strip
 * derives from real session history + freeze-used days; blue = saved by a
 * freeze. Reassuring, never alarming.
 */
import React, { useMemo } from 'react';
import { Text, View } from 'react-native';

import { Ion, Sheet } from '@/components/ui';
import { addDays, dayKeyOf } from '@/domain/types';
import { useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

type DayMark = 's' | 'f' | 'm' | 't';

export function StreakSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = useColors();
  const { state } = useData();
  const { person, sessions } = state;

  const now = useNow();
  const days: DayMark[] = useMemo(() => {
    const today = dayKeyOf(now);
    const studied = new Set(sessions.map((s) => s.dayKey));
    const frozen = new Set(person.freezeUsedDays);
    const out: DayMark[] = [];
    for (let back = 13; back >= 0; back--) {
      const key = addDays(today, -back);
      if (back === 0) out.push('t');
      else if (frozen.has(key)) out.push('f');
      else if (studied.has(key)) out.push('s');
      else out.push('m');
    }
    return out;
  }, [sessions, person.freezeUsedDays, now]);

  const recentlySaved = days.includes('f');

  const dotStyle = (d: DayMark) =>
    ({
      s: { bg: c.amber, icon: null as string | null },
      f: { bg: c.infoTint, icon: 'snow' },
      m: { bg: c.paperSunk, icon: null },
      t: { bg: c.pine, icon: null },
    })[d];

  return (
    <Sheet open={open} onClose={onClose} title="Your streak">
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text
          style={[font('sans', 800), tnum, { fontSize: 44, color: c.ink, letterSpacing: -1.3 }]}
        >
          {person.streak}
        </Text>
        <Text style={[font('serif', 400, true), { fontSize: 19, color: c.ink2 }]}>
          days in a row
        </Text>
      </View>
      <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink3, marginTop: 2, marginBottom: 16 }]}>
        Best: {person.bestStreak} days
      </Text>

      <View style={{ flexDirection: 'row', gap: 7, marginBottom: 8 }}>
        {days.map((d, i) => {
          const m = dotStyle(d);
          return (
            <View
              key={i}
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                backgroundColor: m.bg,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: d === 't' ? 2 : 0,
                borderColor: d === 't' ? c.pineDeep : undefined,
              }}
            >
              {m.icon ? <Ion name={m.icon} size={12} color={c.info} /> : null}
            </View>
          );
        })}
      </View>
      <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginBottom: 18 }]}>
        Last 14 days · blue = saved by a freeze
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
        <Ion name="snow" size={20} color={c.info} />
        <View style={{ flex: 1 }}>
          <Text style={[font('sans', 700), { fontSize: 14, color: c.ink }]}>
            {person.freezes} streak {person.freezes === 1 ? 'freeze' : 'freezes'}
          </Text>
          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink2 }]}>
            A freeze bridges one missed day. Earn one at every 7-day milestone.
          </Text>
        </View>
      </View>

      {recentlySaved && (
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
          <Ion name="shield-checkmark" size={18} color={c.success} />
          <Text style={[font('sans', 400), { flex: 1, fontSize: 13, color: c.ink }]}>
            Recently your streak was saved — 1 freeze used.
          </Text>
        </View>
      )}
    </Sheet>
  );
}
