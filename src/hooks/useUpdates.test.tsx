import { act, renderHook, waitFor } from '@testing-library/react';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { describe, expect, it, vi } from 'vitest';
import { saveWindowState } from '../lib/transport';
import { CHECK_INTERVAL_MS, CHECK_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, useUpdates } from './useUpdates';

type Mock = ReturnType<typeof vi.fn>;

function fakeUpdate(version: string, download?: (onEvent: (e: DownloadEvent) => void) => Promise<void>) {
  return {
    version,
    close: vi.fn(() => Promise.resolve()),
    download: vi.fn(download ?? (() => Promise.resolve())),
    install: vi.fn(() => Promise.resolve()),
  } as unknown as Update & { close: Mock; download: Mock; install: Mock };
}

describe('useUpdates', () => {
  it('checks at launch and offers what it finds', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('1.2.0'));
    const { result } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'available', version: '1.2.0' }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('gives up on a stalled check', async () => {
    renderHook(() => useUpdates(true));
    await waitFor(() => expect(check).toHaveBeenCalledWith({ timeout: CHECK_TIMEOUT_MS }));
  });

  it('reports the outcome of a manual check made while an automatic one runs', async () => {
    let finish: (u: Update | null) => void = () => undefined;
    vi.mocked(check).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    act(() => result.current.checkNow());
    expect(result.current.state).toEqual({ kind: 'checking' });
    await act(async () => finish(null));
    expect(check).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: 'current' });
  });

  it('does not check on its own when automatic checks are off', async () => {
    const { result } = renderHook(() => useUpdates(false));
    await act(async () => {});
    expect(check).not.toHaveBeenCalled();
    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'current' }));
  });

  it('checks again every few hours', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useUpdates(true));
      await act(async () => {});
      expect(check).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(CHECK_INTERVAL_MS));
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails quietly on automatic checks and reports checks the user started', async () => {
    vi.mocked(check).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useUpdates(true));
    await act(async () => {});
    expect(result.current.state).toEqual({ kind: 'idle' });
    act(() => result.current.checkNow());
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: 'error', message: 'Could not check for updates: offline' }),
    );
  });

  it('keeps an update found earlier when a later automatic check fails', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(check).mockResolvedValueOnce(fakeUpdate('1.2.0')).mockRejectedValue(new Error('offline'));
      const { result } = renderHook(() => useUpdates(true));
      await act(async () => {});
      await act(async () => vi.advanceTimersByTime(CHECK_INTERVAL_MS));
      expect(check).toHaveBeenCalledTimes(2);
      expect(result.current.state).toEqual({ kind: 'available', version: '1.2.0' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an update it replaces or no longer needs', async () => {
    const first = fakeUpdate('1.2.0');
    const second = fakeUpdate('1.3.0');
    vi.mocked(check).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { result, unmount } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(result.current.state).toMatchObject({ version: '1.2.0' }));
    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state).toMatchObject({ version: '1.3.0' }));
    expect(first.close).toHaveBeenCalled();
    unmount();
    expect(second.close).toHaveBeenCalled();
  });

  it('downloads with progress, installs and restarts', async () => {
    let emit: (e: DownloadEvent) => void = () => undefined;
    let finish: () => void = () => undefined;
    const found = fakeUpdate('1.2.0', (onEvent) => {
      emit = onEvent;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    vi.mocked(check).mockResolvedValue(found);
    const { result } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(result.current.state.kind).toBe('available'));
    act(() => result.current.install());
    expect(result.current.state).toEqual({ kind: 'downloading', version: '1.2.0', percent: null });
    expect(found.download).toHaveBeenCalledWith(expect.any(Function), { timeout: DOWNLOAD_TIMEOUT_MS });
    act(() => {
      emit({ event: 'Started', data: { contentLength: 200 } });
      emit({ event: 'Progress', data: { chunkLength: 50 } });
    });
    expect(result.current.state).toEqual({ kind: 'downloading', version: '1.2.0', percent: 25 });
    expect(saveWindowState).not.toHaveBeenCalled();
    await act(async () => finish());
    // The window is saved after the download, right before installing: on
    // Windows the installer ends the app.
    expect(vi.mocked(saveWindowState).mock.invocationCallOrder[0]).toBeLessThan(
      found.install.mock.invocationCallOrder[0]!,
    );
    expect(result.current.state).toEqual({ kind: 'restarting', version: '1.2.0' });
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(found.close).not.toHaveBeenCalled();
  });

  it('reports a failed install so it can be tried again', async () => {
    const found = fakeUpdate('1.2.0', () => Promise.reject(new Error('signature mismatch')));
    vi.mocked(check).mockResolvedValue(found);
    const { result } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(result.current.state.kind).toBe('available'));
    act(() => result.current.install());
    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: 'error',
        message: 'Could not install IsItGreen 1.2.0: signature mismatch',
        version: '1.2.0',
      }),
    );
    expect(relaunch).not.toHaveBeenCalled();
    act(() => result.current.install());
    await waitFor(() => expect(found.download).toHaveBeenCalledTimes(2));
    expect(found.install).not.toHaveBeenCalled();
  });

  it('keeps offering a known update when a later manual check fails', async () => {
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate('1.2.0')).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(result.current.state.kind).toBe('available'));
    act(() => result.current.checkNow());
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'available', version: '1.2.0' }));
  });

  it('hides a dismissed update until a newer one turns up', async () => {
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate('1.2.0')).mockResolvedValueOnce(fakeUpdate('1.2.0'));
    const { result } = renderHook(() => useUpdates(true));
    await waitFor(() => expect(result.current.state.kind).toBe('available'));
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    act(() => result.current.checkNow());
    expect(result.current.state.kind).toBe('checking');
    await waitFor(() => expect(result.current.state.kind).toBe('available'));
    expect(check).toHaveBeenCalledTimes(2);
    expect(result.current.dismissed).toBe(true);
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate('1.3.0'));
    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state).toMatchObject({ version: '1.3.0' }));
    expect(result.current.dismissed).toBe(false);
  });
});
