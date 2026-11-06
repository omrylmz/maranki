/**
 * Entrance motion: fade + short rise (8–12px), the design's standard enter.
 * Honors OS reduced-motion (spec §8.12): with Reduce Motion on, the content
 * renders at once — no fade, no rise, no pop. The value comes from
 * useReduceMotion(), which also follows a change of the setting while the
 * app runs.
 */
import React, { useEffect, useState } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';

import { useReduceMotion } from '@/store/useReduceMotion';

interface RiseInProps {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
  /** 'pop' uses the spring overshoot (reward moments). */
  kind?: 'rise' | 'pop';
}

export function RiseIn({
  children,
  delay = 0,
  duration = 350,
  distance = 10,
  style,
  kind = 'rise',
}: RiseInProps) {
  const reduced = useReduceMotion();
  // Already reduced on the first render → start at the end (shown at once).
  const [anim] = useState(() => new Animated.Value(reduced ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      anim.stopAnimation();
      anim.setValue(1);
      return;
    }
    Animated.timing(anim, {
      toValue: 1,
      duration,
      delay,
      easing:
        kind === 'pop' ? Easing.bezier(0.34, 1.56, 0.64, 1) : Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    }).start();
  }, [anim, delay, duration, kind, reduced]);

  return (
    <Animated.View
      style={[
        {
          opacity: anim,
          transform:
            kind === 'pop'
              ? [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }]
              : [
                  {
                    translateY: anim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [distance, 0],
                    }),
                  },
                ],
        },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}
