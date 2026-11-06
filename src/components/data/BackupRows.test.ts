/**
 * Tests for the backup rows (src/components/data/BackupRows.tsx), W3-7:
 * the Delete (trash) button is the UI kit's IconBtn now, so a screen reader
 * hears its label AND when it is disabled (W2 hardening review: it said
 * nothing while a restore ran). The "Automatic backups" switch is labelled.
 *
 * Module mocks (`jest.mock` below):
 *   - DataContext / SnackbarContext → small fakes (no engine, no provider);
 *   - backup.ts → the real module, except the backup list, which is a fixed
 *     list (no disk);
 *   - ThemeContext → the light palette; icons render nothing; zero safe-area
 *     insets (the delete confirm Sheet).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { type BackupEntry, DELETE_BACKUP_COPY } from '../../store/backup';
import { BackupRows } from './BackupRows';

const mockUpdateAppSettings = jest.fn();
const mockShow = jest.fn();

jest.mock('../../store/DataContext', () => ({
  useData: () => ({ state: { settings: {} }, actions: { updateAppSettings: mockUpdateAppSettings } }),
}));

jest.mock('../../store/SnackbarContext', () => ({ useSnackbar: () => ({ show: mockShow }) }));

/** The rows shown: an export (can be deleted) and a weekly backup (cannot). */
const mockEntries: BackupEntry[] = [
  { name: 'maranki-backup-a.json', uri: 'file:///a', size: 2048, modifiedAt: null, kind: 'export', at: 1_700_000_000_000 },
  { name: 'auto-b.json', uri: 'file:///b', size: 4096, modifiedAt: null, kind: 'auto', at: 1_700_000_000_000 },
];

/** One object: useSyncExternalStore needs the same snapshot on every read. */
const mockList = { files: mockEntries, failed: false };

jest.mock('../../store/backup', () => ({
  ...jest.requireActual<typeof import('../../store/backup')>('../../store/backup'),
  getBackupList: () => mockList,
  subscribeBackupList: () => () => undefined,
}));

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.clearAllMocks();
});

function render(restoring: boolean): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(React.createElement(BackupRows, { onRestore: () => undefined, restoring }));
  });
  return renderer!;
}

/** Host elements (what the screen reader sees) with this label. */
function hostsLabelled(r: ReactTestRenderer, label: string): ReactTestInstance[] {
  return r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
}

/** The Pressable component with this label (it holds `onPress`). */
function pressable(r: ReactTestRenderer, label: string): ReactTestInstance {
  return r.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props)[0];
}

describe('BackupRows accessibility', () => {
  test('one Delete button (only on the export), labelled, enabled while no restore runs', () => {
    const r = render(false);
    const del = hostsLabelled(r, DELETE_BACKUP_COPY.button);
    expect(del).toHaveLength(1); // the weekly backup has no Delete
    expect(del[0].props.accessibilityRole).toBe('button');
    expect(del[0].props.accessibilityState).toEqual({ disabled: false });
    expect(typeof pressable(r, DELETE_BACKUP_COPY.button).props.onPress).toBe('function');
  });

  test('while a restore runs, the Delete button says it is disabled and does nothing', () => {
    const r = render(true);
    const del = hostsLabelled(r, DELETE_BACKUP_COPY.button);
    expect(del[0].props.accessibilityState).toEqual({ disabled: true });
    expect(pressable(r, DELETE_BACKUP_COPY.button).props.onPress).toBeUndefined();
    // The Restore buttons wait too, and say so.
    for (const restore of hostsLabelled(r, 'Restore')) {
      expect(restore.props.accessibilityState).toEqual({ disabled: true });
    }
  });

  test('the "Automatic backups" switch has its name and state', () => {
    const r = render(false);
    const sw = hostsLabelled(r, 'Automatic backups').find((n) => n.props.accessibilityRole === 'switch');
    expect(sw?.props.accessibilityState).toMatchObject({ checked: true });
    act(() => pressable(r, 'Automatic backups').props.onPress());
    expect(mockUpdateAppSettings).toHaveBeenCalledTimes(1);
  });
});
