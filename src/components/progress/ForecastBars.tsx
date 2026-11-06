/**
 * ForecastBars — Progress "NEXT 7 DAYS" (spec §8.8, unit W4-6): one bar
 * per day, today first, with the count above and the day under it.
 *
 *    12   5    3    9    2    0    4
 *    ▇    ▃    ▂    ▅    ▁         ▂
 *   Today Thu  Fri  Sat  Sun  Mon  Tue
 *
 * The numbers come from src/domain/forecast.ts (overdue cards count today).
 * Today's bar is amber: it is the work waiting now; the later days are pine.
 * Numbers only: a bar is not a button (Progress never starts a session).
 *
 * Accessibility (spec §8.12): the chart is ONE element with a summary
 * label ("Due in the next 7 days: 34 cards. Today 12, Thu 5, …"); the
 * bars and numbers inside are not read one by one.
 */
import React from 'react';
import { Text, View } from 'react-native';

import type { ForecastDay } from '@/domain/forecast';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { forecastBars, forecastLabel } from './progressLogic';

/** The height of the tallest bar, in points. */
const BAR_MAX_HEIGHT = 64;

export function ForecastBars({ days }: { days: readonly ForecastDay[] }) {
  const c = useColors();
  const bars = forecastBars(days);
  return (
    <View
      accessible
      accessibilityLabel={forecastLabel(days)}
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingTop: 10, paddingBottom: 4 }}
    >
      {bars.map((bar, i) => (
        <View key={bar.dayKey} style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 5 }}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            style={[font('mono', 400), tnum, { fontSize: 11.5, color: bar.count > 0 ? c.ink2 : c.ink3 }]}
          >
            {bar.count.toLocaleString('en-US')}
          </Text>
          <View
            style={{
              alignSelf: 'stretch',
              height: BAR_MAX_HEIGHT,
              justifyContent: 'flex-end',
              borderBottomWidth: 1,
              borderBottomColor: c.hairline,
            }}
          >
            <View
              style={{
                // A day with cards is never thinner than 3 pt, so it can be seen.
                height: bar.count > 0 ? Math.max(3, Math.round(bar.share * BAR_MAX_HEIGHT)) : 0,
                borderTopLeftRadius: 4,
                borderTopRightRadius: 4,
                backgroundColor: i === 0 ? c.amber : c.pine,
                opacity: i === 0 ? 1 : 0.85,
              }}
            />
          </View>
          <Text
            numberOfLines={1}
            style={[font('sans', i === 0 ? 700 : 400), { fontSize: 11, color: i === 0 ? c.ink : c.ink3 }]}
          >
            {bar.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
