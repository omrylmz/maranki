/**
 * StudyCard — the tap-to-reveal flashcard. Front shows the prompt in big serif;
 * the back echoes the prompt small, a hairline divider, then the answer (big
 * serif) with an optional example (italic) and notes (small muted). The queue
 * is visible as a stack beneath. SRS pills (learning "step N", the red "again"
 * requeue) sit in the top row alongside an optional read-aloud button.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { IconBtn, Ion, Pill, RiseIn } from '@/components/ui';
import { Card } from '@/domain/types';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface StudyCardProps {
  card: Card;
  revealed: boolean;
  /** Learning step label ("1"/"2"…) or null once graduated. */
  step: string | null;
  /** True when this instance was requeued by an "Again" rating this session. */
  requeued?: boolean;
  /** Show the read-aloud button (settings.readAloudEnabled). */
  canSpeak: boolean;
  onReveal: () => void;
  onSpeak: () => void;
}

export function StudyCard({
  card,
  revealed,
  step,
  requeued,
  canSpeak,
  onReveal,
  onSpeak,
}: StudyCardProps) {
  const c = useColors();
  // single long words scale to fit rather than breaking mid-word; phrases wrap
  // on spaces.
  const multiword = card.front.includes(' ');

  return (
    <View>
      {/* queue stack beneath */}
      <View
        style={{
          position: 'absolute',
          left: 14,
          right: 14,
          bottom: -10,
          height: 30,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 18,
          opacity: 0.55,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 7,
          right: 7,
          bottom: -5,
          height: 30,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 18,
          opacity: 0.8,
        }}
      />

      <RiseIn duration={280}>
        <Pressable
          onPress={onReveal}
          style={[
            {
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 20,
              minHeight: 330,
              paddingTop: 18,
              paddingHorizontal: 22,
              paddingBottom: 20,
            },
            c.shadow.card,
          ]}
        >
          {/* card top row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {step ? (
              <Pill mono fg={c.amberDeep} bg={c.amberTint}>
                step {step}
              </Pill>
            ) : null}
            {requeued ? (
              <Pill fg={c.danger} bg={c.dangerTint}>
                again
              </Pill>
            ) : null}
            <View style={{ flex: 1 }} />
            {canSpeak ? (
              <IconBtn
                icon="volume-high-outline"
                size={34}
                iconSize={18}
                color={c.pine}
                bg={c.pineTint}
                onPress={onSpeak}
              />
            ) : null}
          </View>

          {!revealed ? (
            /* front — the prompt */
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Text
                numberOfLines={multiword ? undefined : 1}
                adjustsFontSizeToFit={!multiword}
                minimumFontScale={0.55}
                style={[
                  font('serif', 600),
                  {
                    fontSize: 42,
                    lineHeight: 44,
                    letterSpacing: -0.63,
                    color: c.ink,
                    textAlign: 'center',
                  },
                ]}
              >
                {card.front}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 34 }}>
                <Ion name="hand-left-outline" size={14} color={c.ink3} />
                <Text style={[font('sans', 700), { fontSize: 12.5, color: c.ink3 }]}>
                  Tap to reveal
                </Text>
              </View>
            </View>
          ) : (
            /* back — the answer */
            <RiseIn duration={220} distance={0} style={{ flex: 1 }}>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink3 }]}>
                  {card.front}
                </Text>
                <View
                  style={{ width: 36, height: 1, backgroundColor: c.hairlineStrong, marginVertical: 13 }}
                />
                <Text
                  style={[
                    font('serif', 600),
                    {
                      fontSize: 31,
                      lineHeight: 35,
                      letterSpacing: -0.47,
                      color: c.ink,
                      textAlign: 'center',
                    },
                  ]}
                >
                  {card.back}
                </Text>
                {card.example ? (
                  <Text
                    style={[
                      font('serif', 400, true),
                      {
                        fontSize: 16.5,
                        lineHeight: 24,
                        color: c.ink2,
                        textAlign: 'center',
                        marginTop: 18,
                      },
                    ]}
                  >
                    {card.example}
                  </Text>
                ) : null}
                {card.notes ? (
                  <Text
                    style={[
                      font('sans', 400),
                      { fontSize: 13, color: c.ink3, textAlign: 'center', marginTop: 4 },
                    ]}
                  >
                    {card.notes}
                  </Text>
                ) : null}
              </View>
            </RiseIn>
          )}
        </Pressable>
      </RiseIn>
    </View>
  );
}
