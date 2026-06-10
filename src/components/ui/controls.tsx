/**
 * Controls: segmented control, toggle, stepper, labelled field.
 */
import React, { useEffect, useState } from 'react';
import { Animated, Pressable, Text, TextInput, View } from 'react-native';

import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Ion } from './Ion';
import { Overline } from './layout';

export interface SegOption {
  id: string;
  label: string;
  icon?: string;
}

interface SegCtrlProps {
  options: SegOption[];
  value: string;
  onChange: (id: string) => void;
  size?: 'sm' | 'md';
}

export function SegCtrl({ options, value, onChange, size = 'md' }: SegCtrlProps) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: c.paperSunk,
        borderRadius: 999,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = value === o.id;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            style={[
              {
                flex: 1,
                paddingVertical: size === 'sm' ? 6 : 8,
                paddingHorizontal: size === 'sm' ? 10 : 12,
                borderRadius: 999,
                backgroundColor: on ? c.card : 'transparent',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
              },
              on ? c.shadow.sm : null,
            ]}
          >
            {o.icon ? <Ion name={o.icon} size={14} color={on ? c.ink : c.ink3} /> : null}
            <Text
              numberOfLines={1}
              style={[
                font('sans', 700),
                { fontSize: size === 'sm' ? 12.5 : 13.5, color: on ? c.ink : c.ink3 },
              ]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  const [anim] = useState(() => new Animated.Value(on ? 1 : 0));
  useEffect(() => {
    Animated.timing(anim, { toValue: on ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [on, anim]);
  return (
    <Pressable
      onPress={() => onChange(!on)}
      style={{
        width: 46,
        height: 28,
        borderRadius: 999,
        backgroundColor: on ? c.pine : c.hairlineStrong,
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          left: anim.interpolate({ inputRange: [0, 1], outputRange: [3, 21] }),
          width: 22,
          height: 22,
          borderRadius: 999,
          backgroundColor: '#fff',
          shadowColor: '#000',
          shadowOpacity: 0.25,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 1 },
          elevation: 2,
        }}
      />
    </Pressable>
  );
}

interface StepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  fmt?: (v: number) => string;
}

export function Stepper({ value, onChange, min = 0, max = 999, step = 1, fmt }: StepperProps) {
  const c = useColors();
  const btn = (icon: string, delta: number, disabled: boolean) => (
    <Pressable
      onPress={() => !disabled && onChange(value + delta)}
      style={{
        width: 30,
        height: 30,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.hairlineStrong,
        backgroundColor: c.card,
        opacity: disabled ? 0.35 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ion name={icon} size={15} color={c.ink2} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {btn('remove', -step, value <= min)}
      <Text
        style={[
          font('mono', 500),
          tnum,
          { fontSize: 14.5, color: c.ink, minWidth: 34, textAlign: 'center' },
        ]}
      >
        {fmt ? fmt(value) : value}
      </Text>
      {btn('add', step, value >= max)}
    </View>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
  hint?: string;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  multiline,
  autoFocus,
  hint,
}: FieldProps) {
  const c = useColors();
  return (
    <View style={{ marginBottom: 16 }}>
      <Overline style={{ marginBottom: 7 }}>{label}</Overline>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.ink3}
        autoFocus={autoFocus}
        multiline={multiline}
        style={[
          mono ? font('mono', 400) : font('sans', 400),
          {
            backgroundColor: c.card,
            borderWidth: 1,
            borderColor: c.hairlineStrong,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15.5,
            color: c.ink,
            lineHeight: 22,
            minHeight: multiline ? 64 : undefined,
            textAlignVertical: multiline ? 'top' : 'center',
          },
        ]}
      />
      {hint ? (
        <Text style={[font('sans', 400), { fontSize: 12, color: c.ink3, marginTop: 5 }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
