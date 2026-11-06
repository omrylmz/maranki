/**
 * ErrorScreen — what the app shows instead of a white screen when a screen
 * crashes (spec W1-4).
 *
 * How it is reached: Expo Router wraps a layout in a React error boundary when
 * the layout file exports a function named `ErrorBoundary`. When anything
 * inside that layout throws while rendering, the router renders the export
 * instead, with two props: `error` (what was thrown) and `retry` (renders the
 * layout again). The root layout and the (tabs) layout both export one that
 * renders this screen.
 *
 * Also exported for DataProblemScreen, so the two "something is wrong" screens
 * look and behave the same:
 *   - ProblemView — the layout (icon, title, body, buttons, result line);
 *   - useRescue   — the "Save a copy" button logic (rescueExport.ts).
 *
 * Rules:
 *   - It needs a ThemeProvider above it (useColors). The root layout's boundary
 *     renders OUTSIDE the root layout's own providers, so it adds one.
 *   - It never reads or changes the app state (no useData): the data layer may
 *     be what crashed. "Save a copy" reads only the raw stored text.
 */
import type { ErrorBoundaryProps } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Btn, Ion } from '@/components/ui';
import { CRASH_COPY } from '@/store/problemCopy';
import { rescueExport, rescueReportMessage } from '@/store/rescueExport';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/* --------------------------------------------------------- shared pieces */

/**
 * The "Save a copy" button logic. `save()` never rejects; when it finishes,
 * `message` holds the line to show under the buttons (null after the share
 * sheet opened, because the sheet itself was the answer).
 */
export function useRescue() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(rescueReportMessage(await rescueExport()));
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, message, save };
}

interface ProblemViewProps {
  icon: string;
  iconColor: string;
  title: string;
  body: string;
  /** The buttons, top to bottom. */
  children: React.ReactNode;
  /** The result line under the buttons (e.g. after "Save a copy"). */
  status?: string | null;
  /** Extra content under the result line (DataProblemScreen's help text). */
  footer?: React.ReactNode;
  /** A small technical line at the very bottom (dev builds only). */
  detail?: string | null;
}

/** Centered problem layout on paper. It scrolls, so large text sizes still fit. */
export function ProblemView({
  icon,
  iconColor,
  title,
  body,
  children,
  status,
  footer,
  detail,
}: ProblemViewProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.paper }}
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 28,
        paddingTop: insets.top + 32,
        paddingBottom: insets.bottom + 32,
      }}
    >
      <Ion name={icon} size={48} color={iconColor} />
      <Text
        accessibilityRole="header"
        style={[
          font('serif', 600),
          { fontSize: 24, lineHeight: 30, color: c.ink, marginTop: 14, textAlign: 'center' },
        ]}
      >
        {title}
      </Text>
      <Text
        style={[
          font('sans', 400),
          {
            fontSize: 15,
            lineHeight: 21,
            color: c.ink2,
            marginTop: 8,
            textAlign: 'center',
            maxWidth: 360,
          },
        ]}
      >
        {body}
      </Text>

      <View style={{ alignSelf: 'stretch', alignItems: 'center', marginTop: 24 }}>
        <View style={{ width: '100%', maxWidth: 360, gap: 10 }}>{children}</View>
      </View>

      {status ? (
        // "polite": a screen reader reads the result when it appears (Android).
        <Text
          accessibilityLiveRegion="polite"
          style={[
            font('sans', 500),
            {
              fontSize: 13.5,
              lineHeight: 19,
              color: c.ink2,
              marginTop: 14,
              textAlign: 'center',
              maxWidth: 360,
            },
          ]}
        >
          {status}
        </Text>
      ) : null}

      {footer}

      {detail ? (
        <Text
          selectable
          style={[
            font('mono', 400),
            { fontSize: 11, color: c.ink3, marginTop: 20, textAlign: 'center', maxWidth: 360 },
          ]}
        >
          {detail}
        </Text>
      ) : null}
    </ScrollView>
  );
}

/* ------------------------------------------------------------ the screen */

/**
 * The crash screen. `retry` is the router's: it clears the boundary's error and
 * renders the crashed layout again (for the root layout that also remounts the
 * DataProvider, so the saved data is loaded again).
 */
export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const c = useColors();
  const rescue = useRescue();
  return (
    <ProblemView
      icon="alert-circle-outline"
      iconColor={c.danger}
      title={CRASH_COPY.title}
      body={CRASH_COPY.body}
      status={rescue.message}
      // The error text helps a developer; a learner cannot act on it.
      // JavaScript can throw anything (even `undefined`), so never assume an Error.
      detail={__DEV__ ? (error instanceof Error ? error.message : String(error)) : null}
    >
      <Btn full onPress={() => void retry()}>
        {CRASH_COPY.retry}
      </Btn>
      <Btn full kind="secondary" disabled={rescue.busy} onPress={() => void rescue.save()}>
        {CRASH_COPY.rescue}
      </Btn>
    </ProblemView>
  );
}
