/**
 * Entrance motion: fade + short rise (8–12px), the design's standard enter.
 * Honors OS reduced-motion (transitions become instant).
 */
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleProp, ViewStyle } from 'react-native';

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
  const [anim] = useState(() => new Animated.Value(0));
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
  }, []);

  useEffect(() => {
    if (reduced) {
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
