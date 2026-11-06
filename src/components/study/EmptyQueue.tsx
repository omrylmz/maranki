/**
 * EmptyQueue — the session opened with no card to show (spec §6.10).
 *
 *          ✓
 *   Nothing to study here.
 *   You're all caught up.                    ← or "Today's new cards are done.
 *                                               Come back tomorrow, or practice."
 *   [ Study ahead · 12 ]   [ Practice · 40 ]  ← each only when its count is above 0
 *          [ Back ]                           ← centred
 *
 * The two buttons open the session of the SAME scope (`q`): their numbers are
 * the lengths of the sessions they open (useSessionLength = scope.ts
 * buildSessionQueue), so a button never opens an empty session. Before W4-4
 * the text promised "study ahead" but only "Back" was there.
 *
 * "Today's new cards are done…" is shown only for an empty Study session
 * (`kind` 'scheduled') whose scope still has New cards that today's limits
 * held back (sessionLogic emptyQueueLine). An empty Study ahead or Practice
 * session says "You're all caught up."
 *
 * An expired selection ("Practice the {n} you missed" after an app restart):
 * "This selection is no longer available." and Back only.
 *
 * AllDoneHere — the LAST card LEFT the session (bury, suspend, reschedule, a
 * deleted note; sessionLogic leaveOutcome 'done'). The session screen stays,
 * so the action's Undo is always reachable (wave-5b walkthrough M1):
 *
 *          ✓
 *   All done here.
 *   Suspended                                 ← the action's message
 *   That was the last card of this session.
 *       [ Finish session ]                    ← "Back" when nothing was rated
 *       [ Undo ]                              ← only when the action can be undone
 */
import React from 'react';
import { Text, View } from 'react-native';

import { A11Y_HIDDEN, Btn, Ion } from '@/components/ui';
import type { Query } from '@/domain/model';
import { useScopePool, useSessionLength } from '@/store/selectors';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { ALL_DONE_COPY, EMPTY_QUEUE_COPY, emptyQueueActions, emptyQueueLine, type RouteKind } from './sessionLogic';

interface EmptyQueueProps {
  /** The session's scope. */
  q: Query;
  /** The kind of the session that came out empty (it decides the line under the title). */
  kind: RouteKind;
  /** The selection token is unknown (the app restarted, or it expired). */
  expired?: boolean;
  onBack: () => void;
  /** Open another session of the same scope. */
  onStart: (kind: 'ahead' | 'practice') => void;
}

function Shell({
  title = EMPTY_QUEUE_COPY.title,
  line,
  sub,
  children,
}: {
  title?: string;
  line: string;
  /** A second, quieter line under `line`. */
  sub?: string;
  children: React.ReactNode;
}) {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <View {...A11Y_HIDDEN}>
        <Ion name="checkmark-circle" size={48} color={c.success} />
      </View>
      <Text
        accessibilityRole="header"
        style={[font('serif', 600), { fontSize: 24, color: c.ink, marginTop: 14, textAlign: 'center' }]}
      >
        {title}
      </Text>
      <Text
        style={[
          font('sans', 400),
          { fontSize: 14, lineHeight: 20, color: c.ink2, marginTop: 6, marginBottom: sub ? 4 : 22, textAlign: 'center' },
        ]}
      >
        {line}
      </Text>
      {sub ? (
        <Text style={[font('sans', 400), { fontSize: 13, lineHeight: 19, color: c.ink3, marginBottom: 22, textAlign: 'center' }]}>
          {sub}
        </Text>
      ) : null}
      <View style={{ alignSelf: 'stretch', alignItems: 'center', gap: 10 }}>{children}</View>
    </View>
  );
}

/** The scope has nothing to study: offer the other sessions of the same scope. */
function CaughtUp({ q, kind, onBack, onStart }: Omit<EmptyQueueProps, 'expired'>) {
  const ahead = useSessionLength({ kind: 'ahead', q });
  const practice = useSessionLength({ kind: 'practice', q });
  const studyPool = useScopePool(q, 'study');
  const actions = emptyQueueActions({ ahead, practice });
  return (
    <Shell line={emptyQueueLine(kind, studyPool)}>
      {actions.map((a, i) => (
        <Btn key={a.key} kind={i === 0 ? 'primary' : 'secondary'} style={{ alignSelf: 'center' }} onPress={() => onStart(a.key)}>
          {a.title}
        </Btn>
      ))}
      <Btn kind={actions.length > 0 ? 'ghost' : 'primary'} style={{ alignSelf: 'center' }} onPress={onBack}>
        {EMPTY_QUEUE_COPY.leave}
      </Btn>
    </Shell>
  );
}

export function EmptyQueue({ q, kind, expired = false, onBack, onStart }: EmptyQueueProps) {
  if (expired) {
    return (
      <Shell line={EMPTY_QUEUE_COPY.expired}>
        <Btn style={{ alignSelf: 'center' }} onPress={onBack}>
          {EMPTY_QUEUE_COPY.leave}
        </Btn>
      </Shell>
    );
  }
  return <CaughtUp q={q} kind={kind} onBack={onBack} onStart={onStart} />;
}

interface AllDoneHereProps {
  /** The message of the action that took the last card out ("Suspended", "Next review: Tue 28 Oct · …"). */
  message: string;
  /** How many cards were rated in this session: above 0 → "Finish session" (opens Complete), else "Back". */
  rated: number;
  /** Takes the action back (the card returns to the session); undefined when it cannot be undone. */
  onUndo?: () => void;
  /** "Finish session" (rated > 0) or "Back". */
  onFinish: () => void;
}

export function AllDoneHere({ message, rated, onUndo, onFinish }: AllDoneHereProps) {
  const text = message.trim();
  return (
    <Shell title={ALL_DONE_COPY.title} line={text || ALL_DONE_COPY.last} sub={text ? ALL_DONE_COPY.last : undefined}>
      <Btn style={{ alignSelf: 'center' }} onPress={onFinish}>
        {rated > 0 ? ALL_DONE_COPY.finish : ALL_DONE_COPY.leave}
      </Btn>
      {onUndo ? (
        <Btn
          kind="secondary"
          icon="arrow-undo"
          style={{ alignSelf: 'center' }}
          label={text ? `${ALL_DONE_COPY.undo}: ${text}` : ALL_DONE_COPY.undo}
          onPress={onUndo}
        >
          {ALL_DONE_COPY.undo}
        </Btn>
      ) : null}
    </Shell>
  );
}
