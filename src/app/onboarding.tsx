/**
 * Onboarding: a warm first run of three steps (welcome, goals, ready) with a
 * persistent skip. Finishing saves the goals and lands the learner on Home to
 * add a first deck. Blank slate: nothing is seeded.
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Btn, CardBox, Ion, RiseIn, Row, Stepper } from '@/components/ui';
import { useData } from '@/store/DataContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export default function OnboardingScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { actions } = useData();

  const [step, setStep] = useState(0);
  const [neww, setNeww] = useState(10);
  const [reviews, setReviews] = useState(30);

  const mins = Math.max(2, Math.round(((neww + reviews) * 10) / 60));

  const applyChoices = () => {
    actions.setGoals(reviews, neww);
    actions.updateSrsSettings({ dailyNewLimit: neww, dailyReviewLimit: Math.max(reviews, 30) });
    actions.markOnboarded();
  };

  const finish = () => {
    applyChoices();
    // Blank slate: no decks are seeded, so there is no session to jump into.
    // Pop back to the live (tabs) root (onboarding was pushed on top of it) so
    // the learner lands on Home — router.back() matches skip() and avoids
    // stacking a duplicate (tabs) entry that router.replace('/(tabs)') would.
    router.back();
  };

  const skip = () => {
    actions.markOnboarded();
    router.back();
  };

  const next = () => (step < 2 ? setStep(step + 1) : finish());

  const stepBody = [
    /* 0 — welcome */
    <RiseIn key="w" duration={300}>
      <View style={{ alignItems: 'center' }}>
        <Text
          style={[
            font('serif', 600),
            { fontSize: 44, letterSpacing: -0.88, color: c.ink, marginTop: 30 },
          ]}
        >
          Maranki
        </Text>
        <Text
          style={[
            font('serif', 400, true),
            { fontSize: 19, color: c.ink2, marginTop: 10, marginBottom: 30 },
          ]}
        >
          Learn anything. Keep it.
        </Text>
      </View>
      <CardBox>
        {(
          [
            ['albums-outline', 'Study a few cards a day', 'Short sessions that fit your day.'],
            [
              'repeat',
              'We bring each card back',
              'Just before you’d forget it — that’s spaced repetition.',
            ],
            ['flame', 'Streaks make it stick', 'A little every day beats a lot once a week.'],
          ] as [string, string, string][]
        ).map(([icon, t, s], i, arr) => (
          <View
            key={t}
            style={{
              flexDirection: 'row',
              gap: 13,
              alignItems: 'flex-start',
              paddingVertical: 11,
              borderBottomWidth: i < arr.length - 1 ? 1 : 0,
              borderBottomColor: c.hairlineSoft,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 11,
                backgroundColor: c.pineTint,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ion name={icon} size={17} color={c.pine} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>{t}</Text>
              <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, marginTop: 1 }]}>
                {s}
              </Text>
            </View>
          </View>
        ))}
      </CardBox>
    </RiseIn>,

    /* 1 — goals */
    <RiseIn key="g" duration={300}>
      <Text style={[font('serif', 600), { fontSize: 28, color: c.ink, marginTop: 24, marginBottom: 4 }]}>
        A pace you can keep
      </Text>
      <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2, marginBottom: 18 }]}>
        You can change this anytime in Settings.
      </Text>
      <CardBox>
        <Row padV={12}>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>
              New cards a day
            </Text>
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>
              Fresh cards entering rotation
            </Text>
          </View>
          <Stepper value={neww} onChange={setNeww} min={5} max={50} step={5} />
        </Row>
        <Row padV={12} last>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>Reviews a day</Text>
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>
              Cards coming back to be kept
            </Text>
          </View>
          <Stepper value={reviews} onChange={setReviews} min={10} max={200} step={10} />
        </Row>
      </CardBox>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          marginTop: 16,
        }}
      >
        <Ion name="time-outline" size={15} color={c.pine} />
        <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2 }]}>
          That’s about <Text style={[font('sans', 700), { color: c.ink }]}>{mins} minutes</Text> a
          day.
        </Text>
      </View>
    </RiseIn>,

    /* 2 — ready */
    <RiseIn key="r" duration={300}>
      <View style={{ alignItems: 'center' }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 999,
            backgroundColor: c.amberTint,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 36,
            marginBottom: 18,
          }}
        >
          <Ion name="flame" size={30} color={c.amber} />
        </View>
        <Text
          style={[
            font('serif', 600),
            { fontSize: 28, lineHeight: 33, color: c.ink, marginBottom: 8, textAlign: 'center' },
          ]}
        >
          {neww} new cards a day.
        </Text>
        <Text
          style={[
            font('sans', 400),
            {
              fontSize: 14.5,
              lineHeight: 22,
              color: c.ink2,
              textAlign: 'center',
              maxWidth: 270,
            },
          ]}
        >
          About {Math.max(2, Math.round((neww * 10) / 60))} minutes a day. Add a deck from your
          library to begin, and your streak starts on day one.
        </Text>
      </View>
    </RiseIn>,
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      {/* progress + skip */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: insets.top + 8,
          paddingHorizontal: 20,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={{
                width: i === step ? 22 : 7,
                height: 7,
                borderRadius: 99,
                backgroundColor: i <= step ? c.pine : c.hairlineStrong,
              }}
            />
          ))}
        </View>
        <Pressable onPress={skip} hitSlop={8}>
          <Text style={[font('sans', 700), { fontSize: 14, color: c.ink3 }]}>Skip</Text>
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      >
        {stepBody[step]}
      </ScrollView>

      <View style={{ paddingHorizontal: 22, paddingTop: 14, paddingBottom: insets.bottom + 30 }}>
        {step === 2 ? (
          <Btn full size="lg" icon="arrow-forward" onPress={finish}>
            Get started
          </Btn>
        ) : (
          <Btn full size="lg" onPress={next}>
            Continue
          </Btn>
        )}
      </View>
    </View>
  );
}
