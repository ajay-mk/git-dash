import { useCallback, useEffect, useRef, useState } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** A check the user asked for found nothing newer. */
  | { kind: 'current' }
  | { kind: 'available'; version: string }
  /** `percent` is null while the size is unknown. */
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'restarting'; version: string }
  /** `version` is set when installing that update failed. */
  | { kind: 'error'; message: string; version?: string };

export interface Updates {
  state: UpdateState;
  /** Whether the banner was dismissed for the update it would show. */
  dismissed: boolean;
  checkNow: () => void;
  install: () => void;
  dismiss: () => void;
}

/** How often to look for a new release while the app stays open. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}

/**
 * Looks for a signed release on GitHub at launch and every few hours while
 * `auto` is on, and installs it when asked. Checks the user starts report
 * their outcome; automatic ones only surface an available update.
 */
export function useUpdates(auto: boolean): Updates {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const update = useRef<Update | null>(null);
  // Only one check or install runs at a time.
  const busy = useRef(false);

  const replace = useCallback((next: Update | null) => {
    const prev = update.current;
    update.current = next;
    // Releases what the backend holds for an update that is not installed.
    if (prev && prev !== next) void prev.close().catch(() => undefined);
  }, []);

  const run = useCallback(
    async (manual: boolean) => {
      if (busy.current) return;
      busy.current = true;
      if (manual) setState({ kind: 'checking' });
      try {
        const found = await check();
        replace(found);
        if (found) setState({ kind: 'available', version: found.version });
        else setState(manual ? { kind: 'current' } : { kind: 'idle' });
      } catch (err) {
        // An automatic check fails quietly (offline, no release yet) and
        // keeps showing an update it found earlier.
        if (manual) setState({ kind: 'error', message: `Could not check for updates: ${message(err)}` });
      } finally {
        busy.current = false;
      }
    },
    [replace],
  );

  useEffect(() => {
    if (!auto) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void run(false);
    });
    const timer = setInterval(() => void run(false), CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [auto, run]);

  useEffect(() => () => replace(null), [replace]);

  const install = useCallback(() => {
    const found = update.current;
    if (!found || busy.current) return;
    busy.current = true;
    const version = found.version;
    let total: number | null = null;
    let received = 0;
    setState({ kind: 'downloading', version, percent: null });
    void (async () => {
      try {
        await found.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength || null;
          else if (event.event === 'Progress') {
            received += event.data.chunkLength;
            const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
            setState({ kind: 'downloading', version, percent });
          }
        });
        // Windows exits into the installer above; macOS and Linux restart here.
        setState({ kind: 'restarting', version });
        await relaunch();
      } catch (err) {
        setState({ kind: 'error', message: `Could not install GitDash ${version}: ${message(err)}`, version });
      } finally {
        busy.current = false;
      }
    })();
  }, []);

  const dismiss = useCallback(() => {
    if (update.current) setDismissedVersion(update.current.version);
  }, []);

  const checkNow = useCallback(() => void run(true), [run]);

  const dismissed = state.kind === 'available' && state.version === dismissedVersion;
  return { state, dismissed, checkNow, install, dismiss };
}
