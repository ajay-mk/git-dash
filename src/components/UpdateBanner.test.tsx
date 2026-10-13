import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Updates, UpdateState } from '../hooks/useUpdates';
import { UpdateBanner } from './UpdateBanner';

function updates(state: UpdateState, dismissed = false): Updates {
  return { state, dismissed, checkNow: vi.fn(), install: vi.fn(), dismiss: vi.fn() };
}

describe('UpdateBanner', () => {
  it('offers an available update', async () => {
    const u = updates({ kind: 'available', version: '1.2.0' });
    render(<UpdateBanner updates={u} />);
    expect(screen.getByText('GitDash 1.2.0 is available.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(u.install).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(u.dismiss).toHaveBeenCalled();
  });

  it('stays out of the way when dismissed or when nothing is found', () => {
    const { container, rerender } = render(<UpdateBanner updates={updates({ kind: 'available', version: '1.2.0' }, true)} />);
    expect(container.textContent).toBe('');
    rerender(<UpdateBanner updates={updates({ kind: 'current' })} />);
    expect(container.textContent).toBe('');
    // A failed check is shown in Settings, where it was started.
    rerender(<UpdateBanner updates={updates({ kind: 'error', message: 'Could not check for updates: offline' })} />);
    expect(container.textContent).toBe('');
  });

  it('shows progress and lets a failed install be retried', async () => {
    const { rerender } = render(<UpdateBanner updates={updates({ kind: 'downloading', version: '1.2.0', percent: 40 })} />);
    expect(screen.getByText('Downloading GitDash 1.2.0… 40%')).toBeTruthy();
    const u = updates({ kind: 'error', message: 'Could not install GitDash 1.2.0: offline', version: '1.2.0' });
    rerender(<UpdateBanner updates={u} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not install GitDash 1.2.0: offline');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(u.install).toHaveBeenCalled();
  });
});
