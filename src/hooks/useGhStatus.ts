import { useCallback, useEffect, useState } from 'react';
import { ghStatus, type GhStatus } from '../lib/transport';

/**
 * Whether IsItGreen found the GitHub CLI (`undefined` until checked). Checks
 * whenever `enabled` becomes true (e.g. each time Settings opens) and on
 * `recheck()`, so installing gh while the app is open is picked up.
 */
export function useGhStatus(enabled = true): { status: GhStatus | undefined; recheck: () => void } {
  const [status, setStatus] = useState<GhStatus | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    ghStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ path: null, searched: [] }));
    return () => {
      live = false;
    };
  }, [enabled, nonce]);
  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { status, recheck };
}
