/**
 * Render-safe "now". React Compiler forbids impure calls (Date.now) during
 * render; this hook seeds from module-load time, refreshes on mount, and
 * ticks once a minute — plenty for due-ness granularity (minutes/days).
 * Event handlers and store actions keep calling Date.now() directly.
 */
import { useEffect, useState } from 'react';

const BOOT_NOW = Date.now();
const TICK_MS = 60_000;

export function useNow(): number {
  const [now, setNow] = useState(BOOT_NOW);
  useEffect(() => {
    // async refresh right after mount (sync setState in effects cascades)
    const t0 = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, []);
  return now;
}
