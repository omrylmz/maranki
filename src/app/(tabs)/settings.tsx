/**
 * Settings — a grouped, searchable hub (E1) with unmistakable resets (E2).
 * Search filters the groups; everyday groups first, Advanced and the danger
 * zone last; export shows inline progress (E3); the factory reset enumerates
 * exactly what it destroys and requires a real hold-to-confirm — and it
 * actually erases (factoryReset re-seeds the store).
 */
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import {
  Btn,
  Ion,
  ListRow,
  Page,
  Pill,
  Row,
  ScreenHead,
  SectionHead,
  SegCtrl,
  Sheet,
  StackBar,
  Stepper,
  Toggle,
} from '@/components/ui';
import { levelInfo } from '@/domain/gamification';
import { formatDelay } from '@/domain/srs';
import { DEFAULT_APP_SETTINGS, DEFAULT_SRS, MIN } from '@/domain/types';
import { backupStamp, exportBackup } from '@/store/backup';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, tnum } from '@/theme/tokens';
import { useColors, useTheme } from '@/theme/ThemeContext';

type Drill = null | 'study' | 'algorithm';

const STEP_PRESETS: Record<string, number[]> = {
  relaxed: [10, 60],
  standard: [1, 10],
  intensive: [1, 5, 15],
};

function presetOf(steps: number[]): string {
  const key = steps.join(',');
  return (
    Object.keys(STEP_PRESETS).find((p) => STEP_PRESETS[p].join(',') === key) ?? 'custom'
  );
}

/* ——— drill-in: study & goals (writes real goals + prefs) ——— */
function StudyPrefs({ onBack }: { onBack: () => void }) {
  const c = useColors();
  const { state, actions } = useData();
  const s = state.settings;

  const label = (text: string) => (
    <Text style={[font('sans', 400), { flex: 1, fontSize: 14.5, color: c.ink }]}>{text}</Text>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title="Study & goals" onBack={onBack} />
      <Page pad={20}>
        <SectionHead>Daily goal</SectionHead>
        <Row padV={12}>
          {label('Reviews per day')}
          <Stepper
            value={state.person.goalReviews}
            onChange={(v) => {
              actions.setGoals(v, state.person.goalNew);
              // Keep the scheduler's review cap in step with the goal, else a
              // raised goal is silently capped at the old dailyReviewLimit (M2).
              actions.updateSrsSettings({ dailyReviewLimit: v });
            }}
            min={0}
            max={500}
            step={10}
          />
        </Row>
        <Row padV={12}>
          {label('New cards per day')}
          <Stepper
            value={state.person.goalNew}
            onChange={(v) => {
              actions.setGoals(state.person.goalReviews, v);
              actions.updateSrsSettings({ dailyNewLimit: v });
            }}
            min={0}
            max={100}
            step={5}
          />
        </Row>
        <Row padV={12} last>
          {label('Session limit')}
          <Stepper
            value={s.sessionLimit}
            onChange={(v) => actions.updateAppSettings({ sessionLimit: v })}
            min={5}
            max={100}
            step={5}
          />
        </Row>

        <SectionHead>Study mode</SectionHead>
        <SegCtrl
          value={s.studyMode}
          onChange={(id) => actions.updateAppSettings({ studyMode: id as typeof s.studyMode })}
          options={[
            { id: 'flash', label: 'Cards' },
            { id: 'type', label: 'Typing' },
            { id: 'mc', label: 'Quiz' },
            { id: 'mix', label: 'Mixed' },
          ]}
        />
        {s.studyMode !== 'flash' && (
          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 8 }]}>
            Typing and quiz modes are on the roadmap — sessions run as flashcards for now.
          </Text>
        )}

        <SectionHead>Behavior</SectionHead>
        <Row padV={12}>
          {label('Hints')}
          <Toggle
            on={s.hintsEnabled}
            onChange={(v) => actions.updateAppSettings({ hintsEnabled: v })}
          />
        </Row>
        <Row padV={12} last>
          <View style={{ flex: 1 }}>
            <Text style={[font('sans', 400), { fontSize: 14.5, color: c.ink }]}>
              Retry missed cards
            </Text>
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3 }]}>
              An extra round at the end of a session
            </Text>
          </View>
          <Toggle
            on={s.retryMissed}
            onChange={(v) => actions.updateAppSettings({ retryMissed: v })}
          />
        </Row>
      </Page>
    </View>
  );
}

/* ——— drill-in: algorithm tuning — real SM-2 knobs, per-knob reset (E4) ——— */
function AlgorithmPrefs({ onBack }: { onBack: () => void }) {
  const c = useColors();
  const { state, actions } = useData();
  const srs = state.settings.srs;
  const preset = presetOf(srs.learningStepsMin);

  const knob = (
    label: string,
    plain: string,
    val: number,
    set: (v: number) => void,
    min: number,
    max: number,
    step: number,
    dflt: number,
    fmt: (n: number) => string,
  ) => (
    <View key={label} style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.hairlineSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink }]}>{label}</Text>
          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}>
            {plain}
          </Text>
        </View>
        <Stepper
          value={val}
          onChange={(n) => set(Math.round(n * 100) / 100)}
          min={min}
          max={max}
          step={step}
          fmt={fmt}
        />
      </View>
      {val !== dflt && (
        <Pressable onPress={() => set(dflt)} hitSlop={6} style={{ paddingTop: 6 }}>
          <Text style={[font('sans', 700), { fontSize: 12, color: c.pine }]}>
            Reset to default ({fmt(dflt)})
          </Text>
        </Pressable>
      )}
    </View>
  );

  const stepsLine = `steps: ${srs.learningStepsMin.map((m) => formatDelay(m * MIN)).join(' → ')} · graduate at ${srs.graduatingIntervalDays}d`;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title="Algorithm tuning" sub="Beta — changes apply instantly" onBack={onBack} />
      <Page pad={20}>
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            alignItems: 'flex-start',
            backgroundColor: c.warningTint,
            borderRadius: 12,
            paddingVertical: 11,
            paddingHorizontal: 14,
            marginTop: 14,
          }}
        >
          <Ion name="warning-outline" size={17} color={c.warning} style={{ marginTop: 1 }} />
          <Text style={[font('sans', 400), { flex: 1, fontSize: 13, lineHeight: 19, color: c.ink }]}>
            These knobs reshape your review schedule. The defaults work well for most learners.
          </Text>
        </View>

        {knob(
          'Easy bonus',
          `Easy cards wait ${Math.round((srs.easyBonus - 1) * 100)}% longer`,
          srs.easyBonus,
          (v) => actions.updateSrsSettings({ easyBonus: v }),
          1.0,
          3.0,
          0.05,
          DEFAULT_SRS.easyBonus,
          (n) => `${n.toFixed(2)}×`,
        )}
        {knob(
          'Hard interval',
          `Hard cards grow at ${srs.hardMultiplier.toFixed(2)}× pace`,
          srs.hardMultiplier,
          (v) => actions.updateSrsSettings({ hardMultiplier: v }),
          1.0,
          1.5,
          0.05,
          DEFAULT_SRS.hardMultiplier,
          (n) => `${n.toFixed(2)}×`,
        )}
        {knob(
          'Interval modifier',
          'Scales every interval — lower studies more often',
          srs.intervalModifier,
          (v) => actions.updateSrsSettings({ intervalModifier: v }),
          0.5,
          1.5,
          0.05,
          DEFAULT_SRS.intervalModifier,
          (n) => `${n.toFixed(2)}×`,
        )}

        <View style={{ paddingVertical: 14 }}>
          <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink, marginBottom: 8 }]}>
            Learning steps
          </Text>
          <SegCtrl
            value={preset}
            onChange={(id) => {
              if (STEP_PRESETS[id]) actions.updateSrsSettings({ learningStepsMin: STEP_PRESETS[id] });
            }}
            options={[
              { id: 'relaxed', label: 'Relaxed' },
              { id: 'standard', label: 'Standard' },
              { id: 'intensive', label: 'Intensive' },
            ]}
          />
          <Text style={[font('mono', 400), { fontSize: 12, color: c.ink3, marginTop: 8 }]}>
            {stepsLine}
          </Text>
        </View>
      </Page>
    </View>
  );
}

/* ——— the hub ——— */
export default function SettingsScreen() {
  const c = useColors();
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const { state, actions } = useData();
  const { show } = useSnackbar();

  const [q, setQ] = useState('');
  const [drill, setDrill] = useState<Drill>(null);
  const [eraseOpen, setEraseOpen] = useState(false);

  const match = (...words: string[]) =>
    !q || words.some((w) => w.toLowerCase().includes(q.toLowerCase()));

  const consequences = useMemo(() => {
    const level = levelInfo(state.person.xp);
    return [
      `${state.decks.length} decks and ${state.cards.length.toLocaleString('en-US')} cards`,
      `All scheduling progress and ${state.sessions.length} sessions`,
      `Your ${state.person.streak}-day streak and level ${level.level}`,
      'Every setting, theme and reminder',
    ];
  }, [state]);

  const doExport = () => {
    try {
      const { name } = exportBackup(state, backupStamp(new Date()));
      show(`Backup saved — ${name}`);
    } catch {
      show('Backup failed — could not write the file');
    }
  };

  if (drill === 'study') return <StudyPrefs onBack={() => setDrill(null)} />;
  if (drill === 'algorithm') return <AlgorithmPrefs onBack={() => setDrill(null)} />;

  const s = state.settings;

  return (
    <Page>
      <ScreenHead title="Settings" />

      {/* search */}
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
        <Ion name="search" size={16} color={c.ink3} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search settings…"
          placeholderTextColor={c.ink3}
          autoCorrect={false}
          style={[font('sans', 400), { flex: 1, fontSize: 14, color: c.ink, padding: 0 }]}
        />
        {q !== '' && (
          <Pressable onPress={() => setQ('')} hitSlop={8}>
            <Ion name="close-circle" size={16} color={c.ink3} />
          </Pressable>
        )}
      </View>

      {match('theme', 'appearance', 'dark', 'evening', 'light', 'paper', 'system') && (
        <View>
          <SectionHead>Appearance</SectionHead>
          <SegCtrl
            value={mode}
            onChange={(id) => setMode(id as typeof mode)}
            options={[
              { id: 'light', label: 'Paper', icon: 'sunny-outline' },
              { id: 'dark', label: 'Evening', icon: 'moon-outline' },
              { id: 'system', label: 'System', icon: 'phone-portrait-outline' },
            ]}
          />
        </View>
      )}

      {(match('learning', 'study', 'goals', 'daily', 'mode', 'hints') ||
        match('language') ||
        match('reminders', 'notifications')) && (
        <View>
          <SectionHead>Learning</SectionHead>
          {match('learning', 'study', 'goals', 'daily', 'mode', 'hints') && (
            <ListRow
              icon="school-outline"
              title="Study & goals"
              sub={`${state.person.goalReviews} reviews · ${state.person.goalNew} new per day · ${
                s.studyMode === 'flash' ? 'flashcards' : s.studyMode
              } · hints ${s.hintsEnabled ? 'on' : 'off'}`}
              onPress={() => setDrill('study')}
            />
          )}
          {match('language') && (
            <ListRow
              icon="globe-outline"
              title="Languages"
              sub="Interface English · learning German & Spanish"
              onPress={() => show('Language picker')}
            />
          )}
          {match('reminders', 'notifications') && (
            <ListRow
              icon="notifications-outline"
              title="Reminders"
              sub={
                s.reminderEnabled ? `Daily at 9:00 PM · next: tomorrow` : 'Off — streaks need you'
              }
              last
              right={
                <Toggle
                  on={s.reminderEnabled}
                  onChange={(v) => {
                    actions.updateAppSettings({ reminderEnabled: v });
                    show(v ? 'Reminders on — daily at 9:00 PM' : 'Reminders off');
                  }}
                />
              }
            />
          )}
        </View>
      )}

      {match('pronunciation', 'audio', 'speech', 'freeze', 'streak') && (
        <View>
          <SectionHead>Habit & speech</SectionHead>
          {match('pronunciation', 'audio', 'speech') && (
            <ListRow
              icon="mic-outline"
              title="Pronunciation practice"
              sub="Prompt on hard cards"
              right={
                <Toggle
                  on={s.pronunciationPrompt}
                  onChange={(v) => actions.updateAppSettings({ pronunciationPrompt: v })}
                />
              }
            />
          )}
          {match('audio', 'speech') && (
            <ListRow
              icon="volume-high-outline"
              title="Auto-play audio"
              sub="Speak the word on reveal"
              right={
                <Toggle
                  on={s.autoPlayAudio}
                  onChange={(v) => actions.updateAppSettings({ autoPlayAudio: v })}
                />
              }
            />
          )}
          {match('freeze', 'streak') && (
            <ListRow
              icon="snow-outline"
              iconColor={c.info}
              iconBg={c.infoTint}
              title="Streak freezes"
              sub={`${state.person.freezes} available · earn one at every 7-day milestone`}
              last
              right={<Pill mono>{state.person.freezes}</Pill>}
            />
          )}
        </View>
      )}

      {match('data', 'import', 'export', 'backup', 'restore') && (
        <View>
          <SectionHead>Your data</SectionHead>
          <ListRow
            icon="cloud-download-outline"
            title="Import"
            sub="CSV · Anki file · AnkiWeb"
            onPress={() => router.push('/import')}
          />
          <ListRow
            icon="cloud-upload-outline"
            title="Export a backup"
            sub="Everything — cards, progress, settings"
            onPress={doExport}
          />
          <ListRow
            icon="refresh-circle-outline"
            title="Restore a backup"
            sub="From a Maranki JSON file"
            last
            onPress={() => show('Choose a backup file to restore')}
          />
        </View>
      )}

      {match('advanced', 'algorithm', 'sm2', 'ease', 'steps', 'beta') && (
        <View>
          <SectionHead>Advanced</SectionHead>
          <ListRow
            icon="options-outline"
            iconColor={c.warning}
            iconBg={c.warningTint}
            title="Algorithm tuning"
            sub="Beta — changes how cards are scheduled"
            onPress={() => setDrill('algorithm')}
            last
          />
        </View>
      )}

      {match('help', 'tour', 'about', 'faq') && (
        <View>
          <SectionHead>Help</SectionHead>
          <ListRow icon="help-buoy-outline" title="Help & FAQ" onPress={() => show('Help center')} />
          <ListRow
            icon="play-circle-outline"
            title="Replay the tour"
            sub="Re-run first-time setup"
            onPress={() => router.push('/onboarding')}
            last
          />
        </View>
      )}

      {match('reset', 'erase', 'delete', 'danger') && (
        <View>
          <SectionHead>Danger zone</SectionHead>
          <View
            style={{
              borderWidth: 1,
              borderColor: c.danger + '4D',
              borderRadius: 14,
              paddingVertical: 2,
              paddingHorizontal: 14,
              backgroundColor: c.danger + '0A',
            }}
          >
            <ListRow
              icon="refresh-outline"
              danger
              title="Reset preferences to defaults"
              sub="Keeps every card, deck, streak and session"
              onPress={() => {
                actions.updateAppSettings(DEFAULT_APP_SETTINGS);
                // Reset the daily goals too (the seed defaults). The goal steppers
                // tie goal↔limit, so leaving a high old goal above the reset limit
                // would desync them — and the goal bars would never fill (L2).
                actions.setGoals(30, 10);
                show('Preferences reset — your study data is untouched');
              }}
            />
            <ListRow
              icon="trash-outline"
              danger
              title="Erase everything & start over"
              sub="Deletes all content and settings"
              last
              onPress={() => setEraseOpen(true)}
            />
          </View>
        </View>
      )}

      <Text
        style={[
          font('mono', 400),
          { fontSize: 11.5, color: c.ink3, textAlign: 'center', paddingTop: 26, paddingBottom: 4 },
        ]}
      >
        Maranki 2.0 · made with care
      </Text>

      {/* factory-reset confirm: enumerated consequences (E2) */}
      <Sheet open={eraseOpen} onClose={() => setEraseOpen(false)} title="Erase everything?">
        <Text
          style={[font('sans', 400), { fontSize: 14, lineHeight: 21, color: c.ink2, marginBottom: 12 }]}
        >
          This is a factory reset. It permanently deletes:
        </Text>
        <View
          style={{
            backgroundColor: c.dangerTint,
            borderRadius: 14,
            paddingVertical: 13,
            paddingHorizontal: 16,
            marginBottom: 16,
          }}
        >
          {consequences.map((line) => (
            <View
              key={line}
              style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 4 }}
            >
              <Ion name="close-circle" size={15} color={c.danger} />
              <Text style={[font('sans', 400), tnum, { flex: 1, fontSize: 13.5, color: c.danger }]}>
                {line}
              </Text>
            </View>
          ))}
        </View>
        <Btn
          kind="secondary"
          full
          icon="cloud-upload-outline"
          style={{ marginBottom: 10 }}
          onPress={() => {
            try {
              const { name } = exportBackup(state, backupStamp(new Date()));
              show(`Backup saved — ${name}`);
            } catch {
              show('Backup failed — could not write the file');
            }
            setEraseOpen(false);
          }}
        >
          Export a backup first
        </Btn>
        <Pressable
          onLongPress={() => {
            setEraseOpen(false);
            actions.factoryReset();
            show('Everything was erased — welcome to a fresh start');
          }}
          delayLongPress={1200}
          style={({ pressed }) => [
            {
              backgroundColor: c.danger,
              borderRadius: 999,
              paddingVertical: 15,
              alignItems: 'center',
              transform: [{ scale: pressed ? 0.97 : 1 }],
            },
            c.shadow.sm,
          ]}
        >
          <Text style={[font('sans', 700), { fontSize: 16.5, color: '#fff' }]}>
            Hold to erase everything
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setEraseOpen(false)}
          style={{ alignSelf: 'center', marginTop: 14 }}
          hitSlop={8}
        >
          <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2 }]}>Keep my data</Text>
        </Pressable>
      </Sheet>
    </Page>
  );
}
