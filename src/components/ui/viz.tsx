/**
 * Data viz: fine ink lines. Bar (progress hairline), SegBar (stacked
 * mastered/learning/new composition), Ring (SVG progress circle).
 */
import React, { useEffect, useState } from 'react';
import { Animated, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { useColors } from '@/theme/ThemeContext';

interface BarProps {
  value: number; // 0–100
  color?: string;
  track?: string;
  h?: number;
  animated?: boolean;
}

export function Bar({ value, color, track, h = 4, animated = true }: BarProps) {
  const c = useColors();
  const [anim] = useState(() => new Animated.Value(Math.min(100, Math.max(0, value))));

  useEffect(() => {
    if (!animated) {
      anim.setValue(Math.min(100, Math.max(0, value)));
      return;
    }
    Animated.timing(anim, {
      toValue: Math.min(100, Math.max(0, value)),
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [value, animated, anim]);

  return (
    <View
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

interface SegBarProps {
  mastered?: number;
  learning?: number;
  neww?: number;
  total?: number;
  h?: number;
}

export function SegBar({ mastered = 0, learning = 0, neww = 0, total, h = 4 }: SegBarProps) {
  const c = useColors();
  const t = total || mastered + learning + neww || 1;
  return (
    <View
      style={{
        flexDirection: 'row',
        height: h,
        backgroundColor: c.paperSunk,
        borderRadius: 999,
        overflow: 'hidden',
        gap: 1,
      }}
    >
      {mastered > 0 && <View style={{ flex: mastered / t, backgroundColor: c.pine }} />}
      {learning > 0 && <View style={{ flex: learning / t, backgroundColor: c.amber }} />}
      {neww > 0 && <View style={{ flex: neww / t, backgroundColor: c.info, opacity: 0.55 }} />}
      <View style={{ flex: Math.max(0, (t - mastered - learning - neww) / t) }} />
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
}

export function Ring({ value, size = 64, stroke = 5, color, track, children }: RingProps) {
  const c = useColors();
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, value / 100));
  return (
    <View style={{ width: size, height: size }}>
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
