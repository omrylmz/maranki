/**
 * Data viz: fine ink lines. Bar (progress hairline), SegBar (stacked status
 * composition), Ring (SVG progress circle).
 *
 * SegBar segments, in this order (spec §8.2, §8.8):
 *   mastered (pine) | review (state.review) | learning (amber) |
 *   new (info, soft) | not started (hairlineStrong) | known (pine, soft)
 * Known is drawn next to Mastered in a lighter pine, but it is its own
 * segment: Known is never counted as mastered.
 *
 * Accessibility (spec §8.12): a chart is never colour only. Pass `label`, a
 * one-line summary ("Level B1: 8 percent mastered"), and a screen reader
 * says it. Without `label` the chart is decoration and is hidden (the text
 * next to it must say the numbers). Bar and Ring are "progressbar"s.
 * Reduce Motion: Bar jumps to its value instead of growing.
 */
import React, { useEffect, useState } from 'react';
import { Animated, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { useReduceMotion } from '@/store/useReduceMotion';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN } from './buttons';

/** A value clamped to 0–100, for a percent bar. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * The accessibility props of a chart: its summary label when there is one,
 * otherwise hidden (decoration).
 */
function chartA11y(label: string | undefined) {
  return label ? { accessible: true, accessibilityLabel: label } : A11Y_HIDDEN;
}

interface BarProps {
  value: number; // 0–100
  color?: string;
  track?: string;
  h?: number;
  animated?: boolean;
  /** Screen-reader summary, e.g. "Reviews: 12 of 30 goal". */
  label?: string;
}

export function Bar({ value, color, track, h = 4, animated = true, label }: BarProps) {
  const c = useColors();
  const reduced = useReduceMotion();
  const pct = clampPercent(value);
  const [anim] = useState(() => new Animated.Value(pct));

  useEffect(() => {
    if (!animated || reduced) {
      anim.stopAnimation();
      anim.setValue(pct);
      return;
    }
    Animated.timing(anim, {
      toValue: pct,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [pct, animated, reduced, anim]);

  return (
    <View
      {...chartA11y(label)}
      accessibilityRole={label ? 'progressbar' : undefined}
      accessibilityValue={label ? { min: 0, max: 100, now: Math.round(pct) } : undefined}
      style={{
        height: h,
        backgroundColor: track ?? c.paperSunk,
        borderRadius: 999,
        overflow: 'hidden',
      }}
    >
      <Animated.View
        style={{
          width: anim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          height: '100%',
          backgroundColor: color ?? c.pine,
          borderRadius: 999,
        }}
      />
    </View>
  );
}

/** The counts a SegBar stacks. Every key is optional (0 by default). */
export interface SegCounts {
  mastered?: number;
  review?: number;
  learning?: number;
  neww?: number;
  notStarted?: number;
  known?: number;
}

/** The segment keys, in drawing order. */
export const SEG_ORDER = ['mastered', 'review', 'learning', 'neww', 'notStarted', 'known'] as const;

export type SegKey = (typeof SEG_ORDER)[number];

/**
 * The flex share of each segment that has cards, in drawing order, and the
 * empty rest. `total` defaults to the sum (and 1 when everything is 0, so
 * an empty bar is just the track):
 *
 *   segShares({ mastered: 1, neww: 3 })  → parts [mastered 0.25, neww 0.75], rest 0
 *   segShares({ mastered: 1 }, 4)        → parts [mastered 0.25], rest 0.75
 */
export function segShares(
  counts: SegCounts,
  total?: number,
): { parts: { key: SegKey; share: number }[]; rest: number } {
  const value = (k: SegKey) => Math.max(0, counts[k] ?? 0);
  const sum = SEG_ORDER.reduce((n, k) => n + value(k), 0);
  const t = total || sum || 1;
  const parts = SEG_ORDER.filter((k) => value(k) > 0).map((key) => ({ key, share: value(key) / t }));
  return { parts, rest: Math.max(0, (t - sum) / t) };
}

interface SegBarProps extends SegCounts {
  total?: number;
  h?: number;
  /** Screen-reader summary, e.g. "Level B1: 8 percent mastered". */
  label?: string;
}

export function SegBar({ total, h = 4, label, ...counts }: SegBarProps) {
  const c = useColors();
  const { parts, rest } = segShares(counts, total);
  const colorOf: Record<SegKey, { color: string; opacity?: number }> = {
    mastered: { color: c.pine },
    review: { color: c.state.review.fg },
    learning: { color: c.amber },
    neww: { color: c.info, opacity: 0.55 },
    notStarted: { color: c.hairlineStrong },
    known: { color: c.pine, opacity: 0.4 },
  };
  return (
    <View
      {...chartA11y(label)}
      style={{
        flexDirection: 'row',
        height: h,
        backgroundColor: c.paperSunk,
        borderRadius: 999,
        overflow: 'hidden',
        gap: 1,
      }}
    >
      {parts.map(({ key, share }) => (
        <View
          key={key}
          style={{ flex: share, backgroundColor: colorOf[key].color, opacity: colorOf[key].opacity }}
        />
      ))}
      <View style={{ flex: rest }} />
    </View>
  );
}

interface RingProps {
  value: number; // 0–100
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: React.ReactNode;
  /** Screen-reader summary, e.g. "62 percent of today's goal". */
  label?: string;
}

export function Ring({ value, size = 64, stroke = 5, color, track, children, label }: RingProps) {
  const c = useColors();
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = clampPercent(value) / 100;
  return (
    <View
      // With a label the ring (and its centre text) is one element; without
      // one, the centre text is read as it is.
      accessible={label ? true : undefined}
      accessibilityLabel={label}
      accessibilityRole={label ? 'progressbar' : undefined}
      accessibilityValue={label ? { min: 0, max: 100, now: Math.round(clamped * 100) } : undefined}
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={track ?? c.paperSunk}
          strokeWidth={stroke}
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color ?? c.pine}
          strokeWidth={stroke}
          strokeDasharray={`${circumference}`}
          strokeDashoffset={circumference * (1 - clamped)}
          strokeLinecap="round"
        />
      </Svg>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </View>
  );
}
