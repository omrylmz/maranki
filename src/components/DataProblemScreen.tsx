/**
 * DataProblemScreen — shown by the root layout INSTEAD of the app when the
 * saved data could not be opened (spec §3.10, W1-4).
 *
 * In that state the data layer is "read-blocked": it saves nothing, so the
 * intact data on disk is never overwritten (C1). This screen only explains
 * what happened and offers three ways out:
 *   - "Try again"                   → `onRetry` (the root layout remounts the
 *                                     DataProvider, which loads the data again);
 *   - "Save a copy of the raw data" → rescueExport.ts (raw text from the live
 *                                     storage port → file → share). The result
 *                                     line says WHY a copy was kept in the app:
 *                                     no share sheet here, or a share that failed;
 *   - "Help"                        → short steps, shown on this same screen.
 *     (No navigator is mounted while this screen is shown, so it cannot open
 *     another route.)
 *
 * Every word comes from src/store/problemCopy.ts (pinned by its test), except
 * the "the share sheet did not open" result line: it comes from
 * `rescueReportMessage` in src/store/rescueExport.ts (pinned in
 * engine.integration.test.ts). The crash screen (ErrorScreen) shows its
 * result line the same way.
 */
import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { Btn, CardBox } from '@/components/ui';
import { DATA_PROBLEM_COPY, DataProblem, PROBLEM_BUTTON } from '@/store/problemCopy';
import { rescueExport, rescueReportMessage } from '@/store/rescueExport';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { ProblemView } from './ErrorScreen';

interface DataProblemScreenProps {
  /** Why the data is blocked. */
  kind: DataProblem;
  /** Load the saved data again. */
  onRetry: () => void;
}

export function DataProblemScreen({ kind, onRetry }: DataProblemScreenProps) {
  const c = useColors();
  const rescue = useRawDataRescue(kind);
  const [helpOpen, setHelpOpen] = useState(false);
  const copy = DATA_PROBLEM_COPY[kind];

  // too-new is not a failure: the fix is an app update, so it gets the calm
  // amber "update" look. Red is kept for real errors (spec §2.1).
  const icon = kind === 'too-new' ? 'arrow-up-circle-outline' : 'alert-circle-outline';
  const iconColor = kind === 'too-new' ? c.amber : c.danger;

  return (
    <ProblemView
      icon={icon}
      iconColor={iconColor}
      title={copy.title}
      body={copy.body}
      status={rescue.message}
      footer={helpOpen ? <HelpSteps lines={copy.help} /> : null}
    >
      {copy.actions.map((action, i) => {
        // The first button is the main one; Help is always the quiet text button.
        const kindOf = action === 'help' ? 'ghost' : i === 0 ? 'primary' : 'secondary';
        if (action === 'retry') {
          return (
            <Btn key={action} full kind={kindOf} onPress={onRetry}>
              {PROBLEM_BUTTON.retry}
            </Btn>
          );
        }
        if (action === 'rescue') {
          return (
            <Btn
              key={action}
              full
              kind={kindOf}
              disabled={rescue.busy}
              onPress={() => void rescue.save()}
            >
              {PROBLEM_BUTTON.rescue}
            </Btn>
          );
        }
        return (
          <Btn
            key={action}
            full
            kind={kindOf}
            icon={helpOpen ? 'chevron-up' : 'help-circle-outline'}
            onPress={() => setHelpOpen((open) => !open)}
          >
            {PROBLEM_BUTTON.help}
          </Btn>
        );
      })}
    </ProblemView>
  );
}

/**
 * The "Save a copy of the raw data" button logic. `save()` never rejects; when
 * it finishes, `message` holds the line to show under the buttons (null after
 * the share sheet opened, because the sheet itself was the answer). The line
 * fits the case: "sharing is not available" only when it really is not, and a
 * read failure is never shown as "no saved data" (rescueReportMessage).
 */
function useRawDataRescue(kind: DataProblem) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(rescueReportMessage(await rescueExport(), kind));
    } finally {
      setBusy(false);
    }
  }, [kind]);

  return { busy, message, save };
}

/** The help text: numbered steps in a card. */
function HelpSteps({ lines }: { lines: readonly string[] }) {
  const c = useColors();
  return (
    <CardBox style={{ width: '100%', maxWidth: 360, marginTop: 18, gap: 10 }}>
      {lines.map((line, i) => (
        <View key={line} style={{ flexDirection: 'row', gap: 10 }}>
          <Text style={[font('sans', 700), { fontSize: 14, lineHeight: 20, color: c.pine }]}>
            {i + 1}.
          </Text>
          <Text
            style={[font('sans', 400), { flex: 1, fontSize: 14, lineHeight: 20, color: c.ink2 }]}
          >
            {line}
          </Text>
        </View>
      ))}
    </CardBox>
  );
}
