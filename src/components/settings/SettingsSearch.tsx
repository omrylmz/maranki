/**
 * The Settings search (spec §8.6, §7 #33, unit W4-5): the search box of the
 * Settings hub, and the list of matching rows that live on OTHER pages.
 *
 *   (🔍 Search settings…                 ×)
 *   ON OTHER PAGES
 *   Session size            Settings › Study & limits   ›
 *
 * The words come from SETTINGS_INDEX (settingsIndex.ts), so a search finds a
 * row on any page ("session limit" → Session size). Rows of the hub itself
 * (Appearance, the audio toggles, Help, the danger zone) are filtered in
 * place by the hub, with their real controls; this list holds the rows of
 * the drill-ins, and a tap opens that page.
 *
 * The hub's ScrollView has keyboardShouldPersistTaps="handled" (wave 5b
 * M3): with the search keyboard open, the FIRST tap on a result works (it
 * used to only close the keyboard). A result row closes the keyboard itself
 * before it opens its page.
 *
 * Example (the hub):
 *   const [q, setQ] = useState('');
 *   <SettingsSearchBox value={q} onChange={setQ} />
 *   {q.trim() !== '' ? <SettingsSearchResults query={q} /> : null}
 */
import { type Href, useRouter } from 'expo-router';
import React from 'react';
import { Keyboard, Text, TextInput, View } from 'react-native';

import { A11Y_HIDDEN, IconBtn, Ion, ListRow, SectionHead } from '@/components/ui';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { PAGE_ROUTE, PAGE_TITLE, searchSettings, type SettingsEntry } from './settingsIndex';

interface SettingsSearchBoxProps {
  value: string;
  onChange: (text: string) => void;
}

/** The round search field ("Search settings…") with a labelled clear button. */
export function SettingsSearchBox({ value, onChange }: SettingsSearchBoxProps) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.hairlineStrong,
        borderRadius: 999,
        paddingVertical: 10,
        paddingHorizontal: 16,
        marginTop: 12,
        marginBottom: 4,
      }}
    >
      <View {...A11Y_HIDDEN}>
        <Ion name="search" size={16} color={c.ink3} />
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search settings…"
        placeholderTextColor={c.ink3}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel="Search settings"
        style={[font('sans', 400), { flex: 1, fontSize: 14, color: c.ink, padding: 0 }]}
      />
      {value !== '' ? (
        <IconBtn
          icon="close-circle"
          size={22}
          iconSize={16}
          color={c.ink3}
          label="Clear the search"
          onPress={() => onChange('')}
          style={{ marginVertical: -4 }}
        />
      ) : null}
    </View>
  );
}

/** The rows of the drill-in pages that match `query`, in page order. */
export function drillInMatches(query: string): SettingsEntry[] {
  return searchSettings(query).filter((entry) => entry.page !== 'index');
}

/** "ON OTHER PAGES": every matching row of a drill-in; a tap opens its page. Nothing when none matches. */
export function SettingsSearchResults({ query }: { query: string }) {
  const router = useRouter();
  const matches = drillInMatches(query);
  if (matches.length === 0) return null;
  return (
    <View>
      <SectionHead>On other pages</SectionHead>
      {matches.map((entry, i) => {
        const page = entry.page as Exclude<SettingsEntry['page'], 'index'>;
        return (
          <ListRow
            key={entry.id}
            title={entry.title}
            sub={`Settings › ${PAGE_TITLE[page]}`}
            hint={`Opens ${PAGE_TITLE[page]}`}
            last={i === matches.length - 1}
            onPress={() => {
              // The hub keeps taps while the keyboard is open (keyboardShouldPersistTaps,
              // wave 5b M3), so close the keyboard here: the new page needs the room.
              Keyboard.dismiss();
              // A path of the Settings stack; typed routes may not list it yet.
              router.push(PAGE_ROUTE[page] as Href);
            }}
          />
        );
      })}
    </View>
  );
}

/** The quiet line when nothing on any page matches. */
export function NoSettingsMatch({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text style={[font('sans', 400), { fontSize: 14, lineHeight: 20, color: c.ink3, paddingVertical: 24, textAlign: 'center' }]}>
      {text}
    </Text>
  );
}
