import { useCallback, useEffect, useRef, useState } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { saveWindowState } from '../lib/transport';

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
/** Gives up on a stalled request, so a later check or retry can run. */
export const CHECK_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

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
  // A check already on its way, which later checks wait for instead of
  // starting another.
  const checking = useRef<Promise<Update | null> | null>(null);
  const installing = useRef(false);

  const replace = useCallback((next: Update | null) => {
    const prev = update.current;
    update.current = next;
    // Releases what the backend holds for an update that is not installed.
    if (prev && prev !== next) void prev.close().catch(() => undefined);
  }, []);

  const run = useCallback(
    async (manual: boolean) => {
      if (installing.current) return;
      if (manual) setState({ kind: 'checking' });
      let pending = checking.current;
      if (!pending) {
        const started = check({ timeout: CHECK_TIMEOUT_MS });
        checking.current = pending = started;
        void started
          .then(
            (found) => {
              // An install that started meanwhile keeps its own update.
              if (installing.current) void found?.close().catch(() => undefined);
              else replace(found);
            },
            () => undefined,
          )
          .finally(() => {
            if (checking.current === started) checking.current = null;
          });
      }
      try {
        const found = await pending;
        if (installing.current) return;
        if (found) setState({ kind: 'available', version: found.version });
        else setState(manual ? { kind: 'current' } : { kind: 'idle' });
      } catch (err) {
        // An automatic check fails quietly (offline, no release yet) and
        // keeps showing an update it found earlier.
        if (manual && !installing.current) {
          setState({ kind: 'error', message: `Could not check for updates: ${message(err)}` });
        }
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
    if (!found || installing.current) return;
    installing.current = true;
    const version = found.version;
    let total: number | null = null;
    let received = 0;
    setState({ kind: 'downloading', version, percent: null });
    void (async () => {
      try {
        // Windows ends the app without the usual exit, which saves the window.
        await saveWindowState().catch(() => undefined);
        await found.downloadAndInstall(
          (event) => {
            if (event.event === 'Started') total = event.data.contentLength || null;
            else if (event.event === 'Progress') {
              received += event.data.chunkLength;
              const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
              setState({ kind: 'downloading', version, percent });
            }
          },
          { timeout: DOWNLOAD_TIMEOUT_MS },
        );
        // Windows exits into the installer above; macOS and Linux restart here.
        setState({ kind: 'restarting', version });
        await relaunch();
      } catch (err) {
        setState({ kind: 'error', message: `Could not install GitDash ${version}: ${message(err)}`, version });
      } finally {
        installing.current = false;
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
