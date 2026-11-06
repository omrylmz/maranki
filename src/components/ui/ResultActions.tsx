/**
 * ResultActions — one row of small buttons that act on a filtered result
 * (spec §8.3 Library, §8.13 "ResultActions (Btn sm row)"):
 *
 *   [ Study 34 ]  [ Practice 30 ]  [ Choose (1,585) ]  [ Save as list ]
 *
 * The screen builds the actions from ONE Query, so every number on a button
 * is exactly what it opens (spec §0 idea B). An action whose count is 0 is
 * not shown: the screen sets `hidden` ("Study {n}" — hidden when 0;
 * "Choose ({n})" — hidden when 0). The first shown action is the primary
 * button unless an action names its own `kind`; the rest are secondary. The
 * row wraps on a narrow phone.
 *
 *   <ResultActions
 *     actions={[
 *       { key: 'study', label: `Study ${n}`, onPress: study, hidden: n === 0 },
 *       { key: 'practice', label: `Practice ${p}`, onPress: practice },
 *       { key: 'save', label: 'Save as list', onPress: save },
 *     ]}
 *   />
 */
import React from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';

import { Btn, type BtnKind } from './buttons';

export interface ResultAction {
  /** Stable React key. */
  key: string;
  /** The button text, e.g. "Study 34". */
  label: string;
  onPress: () => void;
  /** Default: 'primary' for the first shown action, 'secondary' for the others. */
  kind?: BtnKind;
  icon?: string;
  /** true = not shown (for example a count of 0). */
  hidden?: boolean;
  disabled?: boolean;
  /** Screen-reader label, when the text alone is not clear ("Practice 30 cards"). */
  a11yLabel?: string;
  /** Screen-reader hint, e.g. 'Doesn’t change your schedule.' */
  hint?: string;
}

/** The actions that are shown, each with its final button kind. */
export function shownResultActions(actions: readonly ResultAction[]): (ResultAction & { kind: BtnKind })[] {
  return actions
    .filter((a) => !a.hidden)
    .map((a, i) => ({ ...a, kind: a.kind ?? (i === 0 ? 'primary' : 'secondary') }));
}

interface ResultActionsProps {
  actions: readonly ResultAction[];
  style?: StyleProp<ViewStyle>;
}

export function ResultActions({ actions, style }: ResultActionsProps) {
  const shown = shownResultActions(actions);
  if (shown.length === 0) return null;
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, style]}>
      {shown.map((a) => (
        <Btn
          key={a.key}
          size="sm"
          kind={a.kind}
          icon={a.icon}
          disabled={a.disabled}
          onPress={a.onPress}
          label={a.a11yLabel}
          hint={a.hint}
        >
          {a.label}
        </Btn>
      ))}
    </View>
  );
}
