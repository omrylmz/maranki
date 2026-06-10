/**
 * The scheduling engine: an SM-2 variant with an Anki-style learning-steps
 * phase, mirroring the original app's `src/utils/sm2.ts` contract described
 * in WIRING.md. Two entry points:
 *
 *   applyRating(card, rating)  — pure; returns the rescheduled card
 *   predictAll(card)           — pure preview; feeds the rating buttons'
 *                                interval labels ("Again · soon", "Good · 9d")
 *
 * The preview/mutate split exists because the design displays the OUTCOME of
 * each rating before the user commits (WIRING.md §4: "compute from SM-2
 * before render").
 */
import {
  Card,
  DAY,
  HOUR,
  MIN,
  Rating,
  SrsSettings,
} from './types';

const MIN_EASE = 1.3;

interface Scheduled {
  ease: number;
  intervalDays: number;
  stepIndex: number | null;
  /** Delay from "now" until the next review, in ms. */
  delayMs: number;
  lapsed: boolean;
}

function clampInterval(days: number, s: SrsSettings): number {
  return Math.min(Math.max(1, Math.round(days)), s.maxIntervalDays);
}

/** Core scheduling decision, shared by applyRating and predictAll. */
function schedule(card: Card, rating: Rating, s: SrsSettings): Scheduled {
  const steps = s.learningStepsMin.length ? s.learningStepsMin : [1, 10];
  const inLearning = card.stepIndex !== null || card.reps === 0;

  if (inLearning) {
    const step = card.stepIndex ?? 0;
    // A relearning card carries its post-lapse interval in intervalDays;
    // a brand-new card carries 0 and graduates to the configured intervals.
    const graduatedInterval =
      card.intervalDays > 0 ? card.intervalDays : s.graduatingIntervalDays;

    switch (rating) {
      case 'again':
        return { ease: card.ease, intervalDays: card.intervalDays, stepIndex: 0, delayMs: steps[0] * MIN, lapsed: false };
      case 'hard':
        // repeat the current step
        return { ease: card.ease, intervalDays: card.intervalDays, stepIndex: step, delayMs: steps[Math.min(step, steps.length - 1)] * MIN, lapsed: false };
      case 'good': {
        const next = step + 1;
        if (next >= steps.length) {
          const iv = clampInterval(graduatedInterval, s);
          return { ease: card.ease, intervalDays: iv, stepIndex: null, delayMs: iv * DAY, lapsed: false };
        }
        return { ease: card.ease, intervalDays: card.intervalDays, stepIndex: next, delayMs: steps[next] * MIN, lapsed: false };
      }
      case 'easy': {
        const iv = clampInterval(Math.max(s.easyIntervalDays, graduatedInterval), s);
        return { ease: card.ease, intervalDays: iv, stepIndex: null, delayMs: iv * DAY, lapsed: false };
      }
    }
  }

  // graduated review card
  switch (rating) {
    case 'again': {
      const ease = Math.max(MIN_EASE, card.ease - 0.2);
      const postLapse = clampInterval(card.intervalDays * s.lapseMultiplier, s);
      return { ease, intervalDays: postLapse, stepIndex: 0, delayMs: steps[0] * MIN, lapsed: true };
    }
    case 'hard': {
      const ease = Math.max(MIN_EASE, card.ease - 0.15);
      const iv = clampInterval(
        Math.max(card.intervalDays + 1, card.intervalDays * s.hardMultiplier * s.intervalModifier),
        s,
      );
      return { ease, intervalDays: iv, stepIndex: null, delayMs: iv * DAY, lapsed: false };
    }
    case 'good': {
      const iv = clampInterval(
        Math.max(card.intervalDays + 1, card.intervalDays * card.ease * s.intervalModifier),
        s,
      );
      return { ease: card.ease, intervalDays: iv, stepIndex: null, delayMs: iv * DAY, lapsed: false };
    }
    case 'easy': {
      const ease = card.ease + 0.15;
      const iv = clampInterval(
        Math.max(card.intervalDays + 2, card.intervalDays * ease * s.easyBonus * s.intervalModifier),
        s,
      );
      return { ease, intervalDays: iv, stepIndex: null, delayMs: iv * DAY, lapsed: false };
    }
  }
}

export function applyRating(card: Card, rating: Rating, s: SrsSettings, now: number): Card {
  const r = schedule(card, rating, s);
  return {
    ...card,
    ease: r.ease,
    intervalDays: r.intervalDays,
    stepIndex: r.stepIndex,
    reps: card.reps + 1,
    lapses: card.lapses + (r.lapsed ? 1 : 0),
    due: now + r.delayMs,
    lastReviewedAt: now,
  };
}

/* ----------------------------------------------------- interval display */

/**
 * Compact human interval, per the design's content rules:
 * "Intervals are compact and human: soon · 10m · 1d · 6d · 2mo."
 */
export function formatDelay(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}

export type Predictions = Record<Rating, string>;

/**
 * What each rating button shows. "Again" always reads "soon" — the card
 * visibly requeues within the running session rather than in N minutes.
 */
export function predictAll(card: Card, s: SrsSettings): Predictions {
  const out = {} as Predictions;
  (['again', 'hard', 'good', 'easy'] as Rating[]).forEach((r) => {
    out[r] = r === 'again' ? 'soon' : formatDelay(schedule(card, r, s).delayMs);
  });
  return out;
}

/** Current interval as a display token ("6d", "2mo") for library rows. */
export function formatIntervalDays(days: number): string {
  return formatDelay(days * DAY);
}

/** Learning-step progress label, e.g. "2/2 · 10m → 1d". */
export function stepLabel(card: Card, s: SrsSettings): string | null {
  if (card.stepIndex === null || card.reps === 0) return null;
  const steps = s.learningStepsMin;
  const cur = Math.min(card.stepIndex + 1, steps.length);
  const here = formatDelay(steps[Math.min(card.stepIndex, steps.length - 1)] * MIN);
  const after =
    card.stepIndex + 1 >= steps.length
      ? formatIntervalDays(card.intervalDays > 0 ? card.intervalDays : s.graduatingIntervalDays)
      : formatDelay(steps[card.stepIndex + 1] * MIN);
  return `${cur}/${steps.length} · ${here} → ${after}`;
}
