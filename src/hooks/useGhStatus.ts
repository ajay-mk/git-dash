import { useEffect, useState } from 'react';
import { ghStatus } from '../lib/transport';

/**
 * Where the GitHub CLI is installed, if GitDash found it: a path, `null` when
 * it is not installed in a known place, or `undefined` until checked. Checks
 * once `enabled` is true, e.g. when the screen that offers gh is shown.
 */
export function useGhPath(enabled = true): string | null | undefined {
  const [path, setPath] = useState<string | null | undefined>(undefined);
  const checked = path !== undefined;
  useEffect(() => {
    if (!enabled || checked) return;
    let live = true;
    ghStatus()
      .then((s) => live && setPath(s.path))
      .catch(() => live && setPath(null));
    return () => {
      live = false;
    };
  }, [enabled, checked]);
  return path;
}
