/**
 * Help & FAQ (`/help?topic=`, spec §2.2, §8.9, unit W4-6) — offline: every
 * word is in src/content/help.ts and src/content/glossary.ts, nothing is
 * downloaded.
 *
 *   ‹  Help & FAQ
 *   ON THIS PAGE
 *     Words we use · How Study picks cards · Filters and lists · …   ← each jumps to its section
 *   Words we use
 *     Deck — A container of cards that you own. …                   ← the §1.2 glossary
 *   How Study picks cards
 *     …
 *
 * `?topic=<id>` opens the screen AT that section (an InfoSheet's "More in
 * Help", Settings, the DataProblemScreen …). An unknown or missing topic
 * starts at the top (`helpTopicParam`).
 *
 * How the jump works: every section reports where it is (`onLayout`, an
 * event — no state change during render). When the asked-for section
 * reports, the list scrolls there once. If the topic changes while the
 * screen is open, an effect scrolls to the new section (scrolling is a side
 * effect, not a state change, so React Compiler's rules are kept).
 *
 * The glossary terms are NOT written here: "Words we use" is built from
 * glossary.ts, so Help and every "?" InfoSheet show the same text. Content
 * markup (**bold**, `code`) is drawn by the InfoSheet's ContentText.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { type LayoutChangeEvent, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContentText } from '@/components/sheets/InfoSheet';
import { A11Y_HIDDEN, Ion, Overline, StackBar } from '@/components/ui';
import { HELP_SECTIONS, type HelpBlock, type HelpSection, type HelpTopicId, helpTopicParam } from '@/content/help';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The screen title. */
const HELP_TITLE = 'Help & FAQ';

/** Space kept above a section when the list jumps to it, in points. */
const JUMP_MARGIN = 12;

/** One block of a section: a paragraph, a small heading, a list, steps or the glossary terms. */
function Block({ block }: { block: HelpBlock }) {
  const c = useColors();
  const body = [font('sans', 400), { fontSize: 15, lineHeight: 22, color: c.ink2 }];
  switch (block.kind) {
    case 'text':
      return <ContentText text={block.text} style={body} />;
    case 'heading':
      return (
        <Overline header style={{ marginTop: 8 }}>
          {block.text}
        </Overline>
      );
    case 'bullets':
    case 'steps':
      return (
        <View style={{ gap: 8 }}>
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <Text
                {...A11Y_HIDDEN}
                style={[font(block.kind === 'steps' ? 'mono' : 'sans', 700), { minWidth: 18, fontSize: 14, lineHeight: 22, color: c.pine }]}
              >
                {block.kind === 'steps' ? `${i + 1}.` : '•'}
              </Text>
              <ContentText text={item} style={[...body, { flex: 1 }]} />
            </View>
          ))}
        </View>
      );
    case 'terms':
      return (
        <View>
          {block.items.map((term, i) => (
            <View
              key={term.id}
              style={{
                paddingVertical: 11,
                borderBottomWidth: i === block.items.length - 1 ? 0 : 1,
                borderBottomColor: c.hairlineSoft,
                gap: 3,
              }}
            >
              <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>{term.word}</Text>
              <ContentText text={term.text} style={[font('sans', 400), { fontSize: 14, lineHeight: 21, color: c.ink2 }]} />
            </View>
          ))}
        </View>
      );
  }
}

/** One Help section: its title and its blocks. Reports its position for the jumps. */
function Section({ section, onLayout }: { section: HelpSection; onLayout: (e: LayoutChangeEvent) => void }) {
  const c = useColors();
  return (
    <View onLayout={onLayout} style={{ paddingTop: 26, gap: 12 }}>
      <Text accessibilityRole="header" style={[font('serif', 600), { fontSize: 23, lineHeight: 28, color: c.ink }]}>
        {section.title}
      </Text>
      {section.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </View>
  );
}

export default function HelpScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ topic?: string | string[] }>();
  const target = helpTopicParam(params.topic);

  const scrollRef = useRef<ScrollView>(null);
  // Where each section starts inside the list (filled by onLayout, read by the jumps).
  const offsets = useRef<Map<HelpTopicId, number> | null>(null);
  // The topic the list already jumped to, so a later layout does not jump again.
  const jumped = useRef<HelpTopicId | null>(null);

  const scrollTo = (id: HelpTopicId, animated: boolean) => {
    const y = offsets.current?.get(id);
    if (y === undefined) return false;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - JUMP_MARGIN), animated });
    return true;
  };

  const sectionLayout = (id: HelpTopicId) => (e: LayoutChangeEvent) => {
    if (offsets.current === null) offsets.current = new Map();
    offsets.current.set(id, e.nativeEvent.layout.y);
    // The asked-for section is placed: jump there once.
    if (id === target && jumped.current !== target && scrollTo(id, false)) jumped.current = target;
  };

  // A new topic while the screen is open (the sections are already placed).
  useEffect(() => {
    if (target === null || jumped.current === target) return;
    const y = offsets.current?.get(target);
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - JUMP_MARGIN), animated: true });
    jumped.current = target;
  }, [target]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title={HELP_TITLE} onBack={close} />
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}
      >
        {/* table of contents: each row jumps to its section */}
        <View style={{ paddingTop: 18 }}>
          <Overline header>On this page</Overline>
          <View style={{ marginTop: 6 }}>
            {HELP_SECTIONS.map((section, i) => (
              <Pressable
                key={section.id}
                onPress={() => scrollTo(section.id, true)}
                accessibilityRole="button"
                accessibilityLabel={section.title}
                accessibilityHint="Jumps to this part of Help"
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 44,
                  borderBottomWidth: i === HELP_SECTIONS.length - 1 ? 0 : 1,
                  borderBottomColor: c.hairlineSoft,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text
                  style={[
                    font('sans', section.id === target ? 700 : 500),
                    { flex: 1, fontSize: 15, color: section.id === target ? c.pine : c.ink },
                  ]}
                >
                  {section.title}
                </Text>
                <View {...A11Y_HIDDEN}>
                  <Ion name="arrow-down" size={15} color={c.ink3} />
                </View>
              </Pressable>
            ))}
          </View>
        </View>

        {HELP_SECTIONS.map((section) => (
          <Section key={section.id} section={section} onLayout={sectionLayout(section.id)} />
        ))}
      </ScrollView>
    </View>
  );
}
