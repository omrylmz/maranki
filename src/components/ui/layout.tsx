/**
 * Layout & type primitives: the ledger Row (the v2 list idiom — hairline
 * rows on paper, not card-soup), Card (reserved for the flashcard and hero
 * moments), screen/stack headers, the scrolling Page, and ListRow.
 *
 * Accessibility (spec §8.12): screen and sheet titles are "header"s (a
 * screen reader can jump between them); a row or card with `onPress` is a
 * "button" and reads its text (or `label`); a long press is offered as an
 * accessibility action too; the back button of StackBar says "Back" (or
 * "Close" for the × icon).
 *
 * Large font sizes (spec §11 E9 "nothing clipped", device pass 2026-11-02):
 *   - text is never cut to one line where the words matter: ListRow's title
 *     and sub wrap onto as many lines as they need;
 *   - `useLargeText()` says when the phone's font size is large (Android
 *     "Larger" and up). Then a screen puts two parts that sit side by side
 *     (a name and its "Study {n}" button) one under the other;
 *   - `buttonPairLayout` puts two buttons side by side while their labels
 *     fit, and one under the other when they do not;
 *   - `StatusBarStrip` keeps a tab screen's content from scrolling under the
 *     clock and the battery icons.
 */
import React from 'react';
import {
  AccessibilityActionEvent,
  Pressable,
  ScrollView,
  StyleProp,
  Text,
  TextStyle,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { font, TABBAR_HEIGHT } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { A11Y_HIDDEN } from './buttons';
import { Ion } from './Ion';

/**
 * The font scale from which the text counts as LARGE: Android's "Larger"
 * font size (1.3) and every size above it (up to 2.0). Below it, the
 * layouts are the normal ones.
 */
export const LARGE_TEXT_SCALE = 1.3;

/**
 * True when the phone's font size is large (see LARGE_TEXT_SCALE):
 *
 *   isLargeText(1)    → false   (the default size)
 *   isLargeText(1.15) → false   (Android "Large")
 *   isLargeText(1.3)  → true    (Android "Larger")
 *   isLargeText(2)    → true    (the largest size)
 *
 * A value that is not a real scale (NaN, 0) counts as the default size.
 */
export function isLargeText(fontScale: number): boolean {
  return Number.isFinite(fontScale) && fontScale >= LARGE_TEXT_SCALE;
}

/**
 * The phone's font size, read on every render (`useWindowDimensions` gives
 * a new value when the learner changes it in the system settings).
 *
 *   const large = useLargeText();
 *   <View style={{ flexDirection: large ? 'column' : 'row' }}>…</View>
 */
export function useLargeText(): boolean {
  const { fontScale } = useWindowDimensions();
  return isLargeText(fontScale);
}

export function Overline({
  children,
  style,
  header,
  lines = 1,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  /** True when the overline titles a section: a screen reader can jump to it. */
  header?: boolean;
  /**
   * How many lines the text may take (default 1, cut with "…"). Today's date
   * passes 2: "SATURDAY 24 OCTOBER" is wider than the room next to the
   * streak chip at the largest font size.
   */
  lines?: number;
}) {
  const c = useColors();
  return (
    <Text
      numberOfLines={lines}
      accessibilityRole={header ? 'header' : undefined}
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
      <Overline header>{children}</Overline>
      {actionLabel ? (
        <Pressable
          onPress={onAction}
          // 13 pt text: 14 pt more on each side makes a target of about 45 pt.
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
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
  /** Screen-reader label of a pressable row. Default: the texts inside the row. */
  label?: string;
  /** Screen-reader hint of a pressable row. */
  hint?: string;
  /** Screen-reader name of the long-press action, e.g. "List actions". Default "More actions". */
  longPressLabel?: string;
  /**
   * 'radio': the row IS one choice of a group (DeleteDeckSheet), so a screen
   * reader says "radio button, checked / not checked". The role and the state
   * must be on the pressable itself: a child's state is never read (the
   * pressable is ONE element with its own label). Default 'button'.
   */
  role?: 'button' | 'radio';
  /** With role 'radio': is this the chosen one? */
  checked?: boolean;
}

/** The accessibility action that stands for a long press (TalkBack / VoiceOver custom action). */
function longPressActions(onLongPress: (() => void) | undefined, label: string | undefined) {
  if (!onLongPress) return {};
  return {
    accessibilityActions: [{ name: 'longpress', label: label ?? 'More actions' }],
    onAccessibilityAction: (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') onLongPress();
    },
  };
}

/** Ledger row — hairline-separated rows directly on paper. */
export function Row({
  children,
  onPress,
  onLongPress,
  padV = 14,
  last,
  style,
  label,
  hint,
  longPressLabel,
  role = 'button',
  checked,
}: RowProps) {
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
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={role === 'radio' ? { checked: !!checked } : undefined}
      {...longPressActions(onLongPress, longPressLabel)}
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
  /** Screen-reader label of a pressable card. Default: the texts inside. */
  label?: string;
  /** Screen-reader hint of a pressable card, e.g. "Starts the session". */
  hint?: string;
}

export function CardBox({ children, style, onPress, pad = 16, label, hint }: CardBoxProps) {
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.99 : 1 }] })}
    >
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
            accessibilityRole="header"
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
  /** Screen-reader label of the back button. Default: "Close" for the × icon, else "Back". */
  backLabel?: string;
}

/** The default label of StackBar's back button: "Close" for the × icon, "Back" otherwise. */
export function backButtonLabel(backIcon: string): string {
  return backIcon === 'close' || backIcon.startsWith('close-') ? 'Close' : 'Back';
}

/** Full-screen stack header (editors, import, onboarding). */
export function StackBar({
  title,
  onBack,
  backIcon = 'chevron-back',
  right,
  sub,
  backLabel,
}: StackBarProps) {
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
      <Pressable
        onPress={onBack}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={backLabel ?? backButtonLabel(backIcon)}
        style={{ width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' }}
      >
        <Ion name={backIcon} size={21} color={c.ink} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          accessibilityRole="header"
          style={[font('sans', 800), { fontSize: 16.5, color: c.ink }]}
        >
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

/**
 * A solid strip of the page colour under the phone's status bar (the clock,
 * the battery, the signal). Android 15 and later always draw the app under a
 * see-through status bar, so a tab screen that scrolls draws its text over
 * the clock (device pass 2026-11-02, F1-6). The strip covers that area; the
 * content scrolls under the strip instead.
 *
 * Put it AFTER the scrolling view, as a sibling, so it is drawn on top:
 *
 *   <>
 *     <Page>…</Page>
 *     <StatusBarStrip />
 *   </>
 *
 * It TAKES the touches in its area (the default pointerEvents 'auto'): a tap
 * there must not reach the row that has scrolled under it, which the learner
 * cannot see (a Today deck row, a Settings row). A screen reader skips it,
 * and it draws nothing when the phone has no top inset.
 */
export function StatusBarStrip() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  if (insets.top <= 0) return null;
  return (
    <View
      {...A11Y_HIDDEN}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: insets.top,
        backgroundColor: c.paper,
        // Above the page, below the FAB (45) and the bottom bars.
        zIndex: 40,
      }}
    />
  );
}

/** The styles of a row of two buttons (see buttonPairLayout). */
export interface ButtonPairLayout {
  /** The View around the two buttons. */
  row: ViewStyle;
  /** The `style` of the first (main) button; undefined = nothing to add. */
  first: ViewStyle | undefined;
  /** The `style` of the second button; undefined = nothing to add. */
  second: ViewStyle | undefined;
}

/**
 * The layout of a row of two FULL buttons where the first one is the main
 * one (the deck page: "Study {n}" and "Practice"). No label is ever cut
 * ("Practi…") or broken inside a word ("Practic" / "e"):
 *
 *   - a large font size (useLargeText): one under the other, each the full
 *     width;
 *   - else a WRAPPING row: side by side, the first one wider (about 1.6 : 1,
 *     as before), while both labels fit on one line. When they do not fit
 *     (Android "Large", 1.15, on a 360 dp phone: "Practice" needs 71 pt and
 *     had 67 pt), the second button goes under the first, and each takes the
 *     full width.
 *
 * How the wrapping row works: each button starts as wide as its label needs
 * (flexBasis 'auto'), and never narrower than its share (minWidth: 58% and
 * 36%, so at the normal font size the widths stay close to 1.6 : 1). When
 * the two do not fit side by side, the row wraps. The free space is shared
 * 1.6 : 1 (flexGrow); a button alone on its line takes the whole line.
 *
 *   const pair = buttonPairLayout(large);
 *   <View style={pair.row}>
 *     <Btn full style={pair.first}>Study 30</Btn>
 *     <Btn full style={pair.second}>Practice</Btn>
 *   </View>
 */
export function buttonPairLayout(large: boolean): ButtonPairLayout {
  if (large) return { row: { flexDirection: 'column', gap: 10 }, first: undefined, second: undefined };
  return {
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    first: { flexGrow: 1.6, flexShrink: 1, flexBasis: 'auto', minWidth: '58%', maxWidth: '100%' },
    second: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: '36%', maxWidth: '100%' },
  };
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
  /** Screen-reader label. Default: the texts of the row (title, sub, and the texts in `right`). */
  label?: string;
  /** Screen-reader hint, e.g. "Opens the deck page". */
  hint?: string;
}

/**
 * Settings-style list row with a tinted icon square.
 *
 * The title and the sub WRAP onto more lines when they do not fit; they are
 * never cut with "…". At the largest font size "Speak the question
 * automatically" and "500 new · 30 reviews a day · sessions of 50 ·
 * Flashcards" need two or three lines (device pass 2026-11-02, F1-3). At the
 * normal font size almost every row still fits on one line.
 */
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
  label,
  hint,
}: ListRowProps) {
  const c = useColors();
  return (
    <Row onPress={onPress} last={last} padV={13} label={label} hint={hint}>
      {icon ? (
        <View
          {...A11Y_HIDDEN}
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
        {/* No numberOfLines: the title and the sub wrap (see above). */}
        <Text style={[font('sans', 700), { fontSize: 15, color: danger ? c.danger : c.ink }]}>
          {title}
        </Text>
        {sub ? (
          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right ?? (
        <View {...A11Y_HIDDEN}>
          <Ion name="chevron-forward" size={16} color={c.ink3} />
        </View>
      )}
    </Row>
  );
}
