import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, type DashboardConfig } from '../config/schema';
import { providers } from '../providers';
import type { InboxSnapshot } from '../providers/types';
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
});
