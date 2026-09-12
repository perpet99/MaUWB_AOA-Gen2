/**
 * Breakpoint state as a value, not just a CSS rule.
 *
 * The chart SVGs need the breakpoint in JavaScript, not only in the stylesheet:
 * label sizes and marker radii live in viewBox units, so the decision to
 * enlarge them has to happen where the geometry is computed.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** Phones and small tablets in portrait. Kept in sync with styles.css. */
export const PHONE_QUERY = '(max-width: 760px)';
