import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, repoId, type DashboardConfig, type PinnedRepo } from '../config/schema';
import { AppError } from '../lib/transport';
import { providers } from '../providers';
import type { RepoBatch } from '../providers/types';
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
    void result.current.refresh({ tokenChanged: true });
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
