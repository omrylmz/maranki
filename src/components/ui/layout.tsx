/**
 * Layout & type primitives: the ledger Row (the v2 list idiom — hairline
 * rows on paper, not card-soup), Card (reserved for the flashcard and hero
 * moments), screen/stack headers, the scrolling Page, and ListRow.
 */
import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleProp,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { font, TABBAR_HEIGHT } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Ion } from './Ion';

export function Overline({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const c = useColors();
  return (
    <Text
      numberOfLines={1}
      style={[
        font('sans', 700),
        {
          fontSize: 11,
          letterSpacing: 11 * 0.09,
          textTransform: 'uppercase',
          color: c.ink3,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

interface SectionHeadProps {
  children: React.ReactNode;
  action?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function SectionHead({ children, action, actionLabel, onAction, style }: SectionHeadProps) {
  const c = useColors();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 26,
          marginBottom: 6,
        },
        style,
      ]}
    >
      <Overline>{children}</Overline>
      {actionLabel ? (
        <Pressable onPress={onAction} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={[font('sans', 700), { fontSize: 13, color: c.pine }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
      {action}
    </View>
  );
}

interface RowProps {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  padV?: number;
  last?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Ledger row — hairline-separated rows directly on paper. */
export function Row({ children, onPress, onLongPress, padV = 14, last, style }: RowProps) {
  const c = useColors();
  const inner = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: padV,
          borderBottomWidth: last ? 0 : 1,
          borderBottomColor: c.hairlineSoft,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress && !onLongPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
    >
      {inner}
    </Pressable>
  );
}

interface CardBoxProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  pad?: number;
}

export function CardBox({ children, style, onPress, pad = 16 }: CardBoxProps) {
  const c = useColors();
  const body = (
    <View
      style={[
        {
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 16,
          padding: pad,
        },
        c.shadow.sm,
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.99 : 1 }] })}>
      {body}
    </Pressable>
  );
}

interface ScreenHeadProps {
  overline?: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Tab-screen header: overline context + big serif title + actions. */
export function ScreenHead({ overline, title, sub, right, style }: ScreenHeadProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[{ paddingTop: insets.top + 14, paddingBottom: 4 }, style]}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          {overline ? <Overline style={{ marginBottom: 6 }}>{overline}</Overline> : null}
          <Text
            style={[
              font('serif', 600),
              { fontSize: 32, lineHeight: 35, letterSpacing: -0.64, color: c.ink },
            ]}
          >
            {title}
          </Text>
          {sub ? (
            <Text
              numberOfLines={1}
              style={[font('sans', 400), { fontSize: 14.5, color: c.ink2, marginTop: 6 }]}
            >
              {sub}
            </Text>
          ) : null}
        </View>
        {right ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 2 }}>
            {right}
          </View>
        ) : null}
      </View>
    </View>
  );
}

interface StackBarProps {
  title: string;
  onBack: () => void;
  backIcon?: string;
  right?: React.ReactNode;
  sub?: string;
}

/** Full-screen stack header (editors, import, onboarding). */
export function StackBar({ title, onBack, backIcon = 'chevron-back', right, sub }: StackBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingTop: insets.top + 8,
        paddingHorizontal: 14,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.hairlineSoft,
      }}
    >
      <Pressable onPress={onBack} hitSlop={8} style={{ width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' }}>
        <Ion name={backIcon} size={21} color={c.ink} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[font('sans', 800), { fontSize: 16.5, color: c.ink }]}>
          {title}
        </Text>
        {sub ? (
          <Text numberOfLines={1} style={[font('sans', 400), { fontSize: 12, color: c.ink3 }]}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

interface PageProps {
  children: React.ReactNode;
  pad?: number;
  /** Extra bottom inset; defaults to clearing the tab bar. */
  bottomExtra?: number;
  style?: StyleProp<ViewStyle>;
  scrollRef?: React.Ref<ScrollView>;
}

/** Scrolling page body on paper, clearing the floating tab bar. */
export function Page({ children, pad = 20, bottomExtra = 24, style, scrollRef }: PageProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      ref={scrollRef}
      style={[{ flex: 1, backgroundColor: c.paper }, style]}
      contentContainerStyle={{
        paddingHorizontal: pad,
        paddingBottom: TABBAR_HEIGHT + insets.bottom + bottomExtra,
      }}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

interface ListRowProps {
  icon?: string;
  iconColor?: string;
  iconBg?: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
  danger?: boolean;
}

/** Settings-style list row with a tinted icon square. */
export function ListRow({
  icon,
  iconColor,
  iconBg,
  title,
  sub,
  right,
  onPress,
  last,
  danger,
}: ListRowProps) {
  const c = useColors();
  return (
    <Row onPress={onPress} last={last} padV={13}>
      {icon ? (
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            backgroundColor: danger ? c.dangerTint : (iconBg ?? c.pineTint),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ion name={icon} size={17} color={danger ? c.danger : (iconColor ?? c.pine)} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={[font('sans', 700), { fontSize: 15, color: danger ? c.danger : c.ink }]}
        >
          {title}
        </Text>
        {sub ? (
          <Text
            numberOfLines={1}
            style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}
          >
            {sub}
          </Text>
        ) : null}
      </View>
      {right ?? <Ion name="chevron-forward" size={16} color={c.ink3} />}
    </Row>
  );
}
