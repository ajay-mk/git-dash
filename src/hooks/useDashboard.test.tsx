import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defaultConfig, type DashboardConfig } from '../config/schema';
import { providers } from '../providers';
import type { InboxSnapshot } from '../providers/types';
import { pinned } from '../test/fixtures';
import { useDashboard } from './useDashboard';

function inbox(viewer: string): InboxSnapshot {
  const empty = { total: 0, items: [] };
  return { viewer, reviewRequests: empty, myPullRequests: empty, assigned: empty, ssoRestricted: false };
}

describe('useDashboard inbox changes', () => {
  it('compares each inbox with the previous one fetched with the same settings', async () => {
    const fetchInbox = vi
      .spyOn(providers.github, 'fetchInbox')
      .mockResolvedValueOnce(inbox('first'))
      .mockResolvedValueOnce(inbox('second'))
      .mockResolvedValueOnce(inbox('third'))
      .mockResolvedValueOnce(inbox('fourth'));
    const onChange = vi.fn();
    const owners: string[] = [];
    const { result, rerender } = renderHook(
      ({ config }: { config: DashboardConfig }) => useDashboard(config, owners, true, onChange),
      { initialProps: { config: defaultConfig() } },
    );

    // The first fetch has nothing to compare against.
    await waitFor(() => expect(result.current.inbox?.viewer).toBe('first'));
    expect(onChange).not.toHaveBeenCalled();

    await act(() => result.current.refresh());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.slice(0, 2)).toEqual([inbox('first'), inbox('second')]);
    expect(typeof onChange.mock.calls[0]?.[2]).toBe('number');

    // New settings start over, so turning a section on does not make all its items new.
    const config = defaultConfig();
    rerender({ config: { ...config, inbox: { ...config.inbox, limit: 15 } } });
    await waitFor(() => expect(result.current.inbox?.viewer).toBe('third'));
    expect(onChange).toHaveBeenCalledTimes(1);

    await act(() => result.current.refresh());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(fetchInbox).toHaveBeenCalledTimes(4);
  });

  it('starts over after a token is added or replaced', async () => {
    vi.spyOn(providers.github, 'fetchInbox').mockResolvedValue(inbox('octocat'));
    const onChange = vi.fn();
    const config = defaultConfig();
    const { result } = renderHook(() => useDashboard(config, [], true, onChange));
    await waitFor(() => expect(result.current.inbox).not.toBeNull());

    await act(() => result.current.refresh({ tokensChanged: true }));
    expect(onChange).not.toHaveBeenCalled();
    await act(() => result.current.refresh());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('starts over when notifications are turned back on', async () => {
    vi.spyOn(providers.github, 'fetchInbox').mockResolvedValue(inbox('octocat'));
    const onChange = vi.fn();
    const config = defaultConfig();
    const { result, rerender } = renderHook(
      ({ watch }: { watch: boolean }) => useDashboard(config, [], true, watch ? onChange : undefined),
      { initialProps: { watch: true } },
    );
    await waitFor(() => expect(result.current.inbox).not.toBeNull());
    // Off and on again with no fetch in between.
    rerender({ watch: false });
    rerender({ watch: true });
    // What changed while nobody watched is not news.
    await act(() => result.current.refresh());
    expect(onChange).not.toHaveBeenCalled();
    await act(() => result.current.refresh());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the comparison time while a token keeps failing', async () => {
    const partial = { ...inbox('octocat'), incomplete: true };
    vi.spyOn(providers.github, 'fetchInbox')
      .mockResolvedValueOnce(inbox('octocat'))
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValue(inbox('octocat'));
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    onTestFinished(() => clock.mockRestore());
    const onChange = vi.fn();
    const config = defaultConfig();
    const { result } = renderHook(() => useDashboard(config, [], true, onChange));
    await waitFor(() => expect(result.current.inbox).not.toBeNull());
    for (let i = 0; i < 3; i++) await act(() => result.current.refresh());
    const times = onChange.mock.calls.map((call) => call[2] as number);
    expect(times).toHaveLength(3);
    // Each comparison goes back to the last complete fetch.
    expect(new Set(times).size).toBe(1);
  });

  describe('while the window is hidden', () => {
    afterEach(() => {
      vi.useRealTimers();
      delete (document as { hidden?: boolean }).hidden;
    });

    async function hiddenPolls(onChange?: () => void) {
      vi.useFakeTimers();
      const fetchInbox = vi.spyOn(providers.github, 'fetchInbox').mockResolvedValue(inbox('octocat'));
      const fetchRepos = vi.spyOn(providers.github, 'fetchRepos').mockResolvedValue({ repos: new Map(), rateLimit: null });
      const config = { ...defaultConfig(), repos: [pinned()], refreshMinutes: 5 };
      renderHook(() => useDashboard(config, [], true, onChange));
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(fetchRepos).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
      return { fetchInbox, fetchRepos };
    }

    it('keeps checking "Needs you" when notifications are on', async () => {
      const { fetchInbox, fetchRepos } = await hiddenPolls(vi.fn());
      expect(fetchInbox).toHaveBeenCalledTimes(2);
      expect(fetchRepos).toHaveBeenCalledTimes(1);
    });

    it('pauses everything when notifications are off', async () => {
      const { fetchInbox, fetchRepos } = await hiddenPolls();
      expect(fetchInbox).toHaveBeenCalledTimes(1);
      expect(fetchRepos).toHaveBeenCalledTimes(1);
    });
  });
});
