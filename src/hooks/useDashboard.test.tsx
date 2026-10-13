import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defaultConfig, repoId, type DashboardConfig, type PinnedRepo } from '../config/schema';
import { AppError } from '../lib/transport';
import { providers } from '../providers';
import type { InboxSnapshot, RepoBatch } from '../providers/types';
import { pinned, snapshot } from '../test/fixtures';
import { useDashboard } from './useDashboard';

const github = pinned('octo', 'repo');

function project(label: string): PinnedRepo {
  return pinned('acme', 'api', { provider: 'gitlab', widgets: [{ type: 'issues', limit: 5, label }] });
}

function config(gitlabLabel: string): DashboardConfig {
  return {
    ...defaultConfig(),
    repos: [github, project(gitlabLabel)],
    inbox: { ...defaultConfig().inbox, enabled: false },
  };
}

function batch(repo: PinnedRepo, fullName: string): RepoBatch {
  return { repos: new Map([[repoId(repo), { ok: true, data: snapshot({ fullName }) }]]), rateLimit: null };
}

describe('useDashboard', () => {
  it("keeps a failed service's data only while its own settings are unchanged", async () => {
    const gh = vi.spyOn(providers.github, 'fetchRepos').mockImplementation(([r]) => Promise.resolve(batch(r!, 'gh')));
    const gl = vi
      .spyOn(providers.gitlab, 'fetchRepos')
      .mockImplementation(([r]) => Promise.resolve(batch(r!, 'issues labelled bug')));
    const { result, rerender } = renderHook(
      ({ cfg }: { cfg: DashboardConfig }) => useDashboard(cfg, [], ['github', 'gitlab'], true),
      { initialProps: { cfg: config('bug') } },
    );
    const glId = repoId(project('bug'));
    await waitFor(() => expect(result.current.repos.get(glId)).toMatchObject({ ok: true }));

    // Same settings: a GitLab failure keeps the cards as they were.
    gl.mockRejectedValue(new AppError('network', 'Could not reach GitLab.'));
    await result.current.refresh();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repos.get(glId)).toMatchObject({ ok: true, data: { fullName: 'issues labelled bug' } });

    // GitLab's label changed: its old issues must not appear under the new label.
    rerender({ cfg: config('ux') });
    await waitFor(() => expect(gh.mock.calls.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(result.current.repos.get(glId)).toMatchObject({ ok: false }));
    expect(result.current.repos.get(repoId(github))).toMatchObject({ ok: true });
  });

  it("does not bring back data read with a replaced token when the new one fails", async () => {
    const gh = vi.spyOn(providers.github, 'fetchRepos').mockImplementation(([r]) => Promise.resolve(batch(r!, 'gh')));
    vi.spyOn(providers.github, 'fetchInbox').mockResolvedValue({
      viewer: 'octocat',
      reviewRequests: { total: 1, items: [] },
      myPullRequests: { total: 0, items: [] },
      assigned: { total: 0, items: [] },
      ssoRestricted: false,
    });
    const cfg = { ...defaultConfig(), repos: [github] };
    const { result } = renderHook(() => useDashboard(cfg, [], ['github'], true));
    await waitFor(() => expect(result.current.repos.get(repoId(github))).toMatchObject({ ok: true }));
    await waitFor(() => expect(result.current.inbox).not.toBeNull());

    gh.mockRejectedValue(new AppError('network', 'Could not reach GitHub.'));
    vi.mocked(providers.github.fetchInbox).mockRejectedValue(new AppError('network', 'Could not reach GitHub.'));
    await result.current.refresh({ tokenChanged: 'github' });
    await waitFor(() => expect(result.current.error?.message).toBe('Could not reach GitHub.'));
    expect(result.current.repos.get(repoId(github))).toBeUndefined();
    expect(result.current.inbox).toBeNull();
  });

  it("keeps another service's data when one service's token is replaced", async () => {
    const gh = vi.spyOn(providers.github, 'fetchRepos').mockImplementation(([r]) => Promise.resolve(batch(r!, 'gh')));
    vi.spyOn(providers.gitlab, 'fetchRepos').mockImplementation(([r]) => Promise.resolve(batch(r!, 'gl')));
    const { result } = renderHook(() => useDashboard(config('bug'), [], ['github', 'gitlab'], true));
    await waitFor(() => expect(result.current.repos.get(repoId(github))).toMatchObject({ ok: true }));

    gh.mockRejectedValue(new AppError('network', 'Could not reach GitHub.'));
    await result.current.refresh({ tokenChanged: 'gitlab' });
    await waitFor(() => expect(result.current.error?.message).toContain('Could not reach GitHub.'));
    expect(result.current.repos.get(repoId(github))).toMatchObject({ ok: true, data: { fullName: 'gh' } });
  });

  it('keeps a rejected token rejected while a background refresh runs', async () => {
    const gh = vi.spyOn(providers.github, 'fetchRepos').mockRejectedValue(new AppError('unauthorized', 'Bad credentials'));
    const cfg = { ...defaultConfig(), repos: [github], inbox: { ...defaultConfig().inbox, enabled: false } };
    const { result } = renderHook(() => useDashboard(cfg, [], ['github'], true));
    await waitFor(() => expect(result.current.rejected).toEqual(['github']));

    // The setup screen depends on this: it must not disappear mid-refresh.
    gh.mockReturnValue(new Promise(() => {}));
    void result.current.refresh();
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.rejected).toEqual(['github']);

    // A newly saved token clears it straight away.
    void result.current.refresh({ tokenChanged: 'github' });
    await waitFor(() => expect(result.current.rejected).toEqual([]));
  });

  it('drops the GitHub rate limit once GitHub is no longer fetched', async () => {
    vi.spyOn(providers.github, 'fetchRepos').mockResolvedValue({
      repos: new Map([[repoId(github), { ok: true, data: snapshot() }]]),
      rateLimit: { remaining: 10, limit: 5000, resetAt: '2026-10-13T18:00:00Z' },
    });
    vi.spyOn(providers.gitlab, 'fetchRepos').mockImplementation(([r]) => Promise.resolve(batch(r!, 'gl')));
    const { result, rerender } = renderHook(
      ({ cfg }: { cfg: DashboardConfig }) => useDashboard(cfg, [], ['github', 'gitlab'], true),
      { initialProps: { cfg: config('bug') } },
    );
    await waitFor(() => expect(result.current.rateLimit?.remaining).toBe(10));
    rerender({ cfg: { ...config('bug'), repos: [project('bug')] } });
    await waitFor(() => expect(result.current.rateLimit).toBeNull());
  });
});

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
      ({ config }: { config: DashboardConfig }) => useDashboard(config, owners, ['github'], true, onChange),
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
    const { result } = renderHook(() => useDashboard(config, [], ['github'], true, onChange));
    await waitFor(() => expect(result.current.inbox).not.toBeNull());

    await act(() => result.current.refresh({ tokenChanged: 'github' }));
    expect(onChange).not.toHaveBeenCalled();
    await act(() => result.current.refresh());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('starts over when notifications are turned back on', async () => {
    const fetchInbox = vi.spyOn(providers.github, 'fetchInbox').mockResolvedValue(inbox('octocat'));
    const onChange = vi.fn();
    const config = defaultConfig();
    const { result, rerender } = renderHook(
      ({ watch }: { watch: boolean }) => useDashboard(config, [], ['github'], true, watch ? onChange : undefined),
      { initialProps: { watch: true } },
    );
    await waitFor(() => expect(result.current.inbox).not.toBeNull());
    expect(fetchInbox).toHaveBeenCalledTimes(1);
    rerender({ watch: false });
    rerender({ watch: true });
    // What changed while nobody watched is not news; turning it back on
    // takes a new baseline right away.
    await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(2));
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
    const { result } = renderHook(() => useDashboard(config, [], ['github'], true, onChange));
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
      renderHook(() => useDashboard(config, [], ['github'], true, onChange));
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
