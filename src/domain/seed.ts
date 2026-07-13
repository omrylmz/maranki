/**
 * First-run state.
 *
 * Maranki opens as a BLANK SLATE: buildSeedState() returns no decks, no cards
 * and zeroed stats. There is no curated corpus — the learner creates or imports
 * every deck themselves. Only the three saved-filter Collections and a zeroed
 * Person are provisioned, so the app is meaningful from the very first launch.
 */
import {
  AppSettings,
  Collection,
  DataState,
  dayKeyOf,
  DEFAULT_APP_SETTINGS,
  Person,
} from './types';

export function buildSeedState(now: number): DataState {
  const today = dayKeyOf(now);

  // A brand-new learner: nothing studied, nothing added. Decks arrive only when
  // the learner creates or imports one — never seeded here.
  const person: Person = {
    xp: 0,
    streak: 0,
    bestStreak: 0,
    freezes: 0,
    freezeUsedDays: [],
    lastStudyDay: '',
    goalReviews: 30,
    goalNew: 10,
    dayDone: { dayKey: today, reviews: 0, neww: 0 },
    fastAnswers: 0,
    achievements: {},
  };

  // Collections are saved smart filters (live queries), not folders — they own
  // no cards, so they're meaningful from the very first launch.
  const collections: Collection[] = [
    { id: 'hard', name: 'Hardest cards', icon: 'flame', desc: 'Lowest ease across decks', query: 'hardest' },
    { id: 'fav', name: 'Favorites', icon: 'heart', desc: 'Cards you starred', query: 'favorites' },
    { id: 'daily', name: 'Daily practice', icon: 'today', desc: 'Young cards · interval 0–7d', query: 'young' },
  ];

  const settings: AppSettings = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS));

  return {
    cards: [],
    decks: [],
    collections,
    person,
    sessions: [],
    reviewLog: [],
    settings,
    onboarded: false,
    inProgressSession: null,
  };
}
