/**
 * Buttons (ui.jsx → RN). Press feedback is the design's tactile scale-down
 * to 0.97 — "like pressing a real card", never a color inversion.
 */
import React from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';

import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Ion } from './Ion';

export type BtnKind =
  | 'primary'
  | 'reward'
  | 'secondary'
  | 'ghost'
  | 'quiet'
  | 'danger'
  | 'dangerSolid';

interface BtnProps {
  kind?: BtnKind;
  icon?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  full?: boolean;
  size?: 'sm' | 'md' | 'lg';
  sub?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Btn({
  kind = 'primary',
  icon,
  children,
  onPress,
  full,
  size = 'md',
  sub,
  disabled,
  style,
}: BtnProps) {
  const c = useColors();
  const padV = size === 'lg' ? 15 : size === 'sm' ? 8 : 12;
  const padH = size === 'lg' ? 26 : size === 'sm' ? 15 : 20;
  const fsz = size === 'lg' ? 16.5 : size === 'sm' ? 13.5 : 15;

  const kinds: Record<BtnKind, { bg: string; fg: string; border?: string; shadow?: ViewStyle }> = {
    primary: { bg: c.pine, fg: c.inkOnColor, shadow: c.shadow.sm },
    reward: { bg: c.amber, fg: '#fff', shadow: c.shadow.sm },
    secondary: { bg: c.card, fg: c.ink, border: c.hairlineStrong },
    ghost: { bg: 'transparent', fg: c.pine },
    quiet: { bg: c.paperSunk, fg: c.ink2 },
    danger: { bg: c.dangerTint, fg: c.danger },
    dangerSolid: { bg: c.danger, fg: '#fff' },
  };
  const k = kinds[kind];

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderRadius: 999,
          paddingVertical: padV,
          paddingHorizontal: padH,
          backgroundColor: k.bg,
          borderWidth: k.border ? 1 : 0,
          borderColor: k.border,
          alignSelf: full ? 'stretch' : 'flex-start',
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
        },
        k.shadow,
        style,
      ]}
    >
      {icon ? <Ion name={icon} size={fsz + 3} color={k.fg} /> : null}
      {sub ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Text style={[font('sans', 700), { fontSize: fsz, color: k.fg, lineHeight: fsz * 1.2 }]}>
            {children}
          </Text>
          <Text style={[font('sans', 600), { fontSize: 12, color: k.fg, opacity: 0.75 }]}>{sub}</Text>
        </View>
      ) : (
        <Text style={[font('sans', 700), { fontSize: fsz, color: k.fg }]} numberOfLines={1}>
          {children}
        </Text>
      )}
    </Pressable>
  );
}

interface IconBtnProps {
  icon: string;
  onPress?: (() => void) | null;
  size?: number;
  iconSize?: number;
  color?: string;
  bg?: string;
  border?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function IconBtn({
  icon,
  onPress,
  size = 38,
  iconSize,
  color,
  bg = 'transparent',
  border,
  disabled,
  style,
}: IconBtnProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={disabled ? undefined : (onPress ?? undefined)}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: 999,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: border ? 1 : 0,
          borderColor: border ? c.hairlineStrong : undefined,
          opacity: disabled ? 0.35 : 1,
          transform: [{ scale: pressed && !disabled ? 0.94 : 1 }],
        },
        style,
      ]}
    >
      <Ion name={icon} size={iconSize ?? size * 0.55} color={color ?? c.ink2} />
    </Pressable>
  );
}

interface FABProps {
  onPress: () => void;
  icon?: string;
  bottom: number;
}

export function FAB({ onPress, icon = 'add', bottom }: FABProps) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          position: 'absolute',
          right: 18,
          bottom,
          width: 54,
          height: 54,
          borderRadius: 999,
          backgroundColor: c.pine,
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 45,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
        c.shadow.md,
      ]}
    >
      <Ion name={icon} size={26} color="#fff" />
    </Pressable>
  );
}
