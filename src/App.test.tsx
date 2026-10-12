import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultConfig } from './config/schema';
import { AppError, githubGraphql, tokens } from './lib/transport';
import { pinned } from './test/fixtures';

const DASHBOARD = { name: 'Pin your first repository' };

function stored(hasDefault: boolean) {
  return { hasDefault, defaultLogin: hasDefault ? 'octocat' : null, owners: [] };
}

function saveConfig(config = defaultConfig()) {
  localStorage.setItem('git-dash.config.v1', JSON.stringify(config));
}

describe('App', () => {
  it('shows token setup when no token is stored', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(false));
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(tokens.list).toHaveBeenCalledWith('github');
    expect(githubGraphql).not.toHaveBeenCalled();
  });

  it('shows the keychain error on the setup screen', async () => {
    vi.mocked(tokens.list).mockRejectedValue(new AppError('keyring', 'The keychain is locked.'));
    render(<App />);
    expect(await screen.findByText('The keychain is locked.')).toBeTruthy();
  });

  it('shows the dashboard when a token is stored', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(true));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    expect(await screen.findByRole('heading', DASHBOARD)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('returns to token setup when GitHub rejects the token', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(true));
    vi.mocked(githubGraphql).mockRejectedValue(new AppError('unauthorized', 'Bad credentials'));
    saveConfig({ ...defaultConfig(), repos: [pinned()] });
    render(<App />);

    expect(await screen.findByText('Your token was rejected or is missing. Please add a new one.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();

    // Saving a new token goes straight back to the dashboard.
    vi.mocked(tokens.set).mockResolvedValue('octocat');
    vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
    await userEvent.type(screen.getByLabelText('Access token'), 'github_pat_NEW');
    await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByRole('heading', { name: 'git-dash' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('stays on the dashboard for errors other than authentication', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(true));
    vi.mocked(githubGraphql).mockRejectedValue(new AppError('network', 'Could not reach GitHub.'));
    saveConfig({ ...defaultConfig(), repos: [pinned()] });
    render(<App />);

    // Shown in the banner and in the sidebar.
    expect((await screen.findAllByText('Could not reach GitHub.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('removing the token clears it and shows token setup', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(true));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove token' }));

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(tokens.clear).toHaveBeenCalledExactlyOnceWith('github');
  });

  it('stays on the dashboard when the keychain refuses to remove the token', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(true));
    vi.mocked(tokens.clear).mockRejectedValue(new AppError('keyring', 'The keychain is locked.'));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove token' }));

    expect(await screen.findByText('Could not remove the token: The keychain is locked.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('persists settings changes', async () => {
    vi.mocked(tokens.list).mockResolvedValue(stored(true));
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'Dark');

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(JSON.parse(localStorage.getItem('git-dash.config.v1')!)).toMatchObject({ theme: 'dark' });
  });

  describe('reordering repo cards', () => {
    const repos = [pinned('octo', 'one'), pinned('octo', 'two'), pinned('octo', 'three')];

    function titles() {
      return screen.getAllByRole('article').map((a) => a.getAttribute('aria-label')?.split(':')[0]);
    }

    function savedOrder() {
      const saved = JSON.parse(localStorage.getItem('git-dash.config.v1') ?? '{}') as { repos: { name: string }[] };
      return saved.repos.map((r) => r.name);
    }

    async function renderRepos() {
      vi.mocked(tokens.list).mockResolvedValue(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      saveConfig({ ...defaultConfig(), repos, inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);
      await screen.findByRole('button', { name: 'Reorder octo/one' });
      // Let the initial (debounced) fetch go out before counting requests.
      await waitFor(() => expect(githubGraphql).toHaveBeenCalled());
      vi.mocked(githubGraphql).mockClear();
    }

    it('moves a card with the arrow keys and saves the order', async () => {
      await renderRepos();
      const handle = screen.getByRole('button', { name: 'Reorder octo/one' });
      handle.focus();
      await userEvent.keyboard('{ArrowDown}');

      expect(titles()).toEqual(['octo/two', 'octo/one', 'octo/three']);
      expect(savedOrder()).toEqual(['two', 'one', 'three']);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder octo/one' }));
      expect(screen.getByText('Moved octo/one to position 2 of 3.')).toBeTruthy();

      await userEvent.keyboard('{End}');
      expect(savedOrder()).toEqual(['two', 'three', 'one']);
      await userEvent.keyboard('{Home}');
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
      await userEvent.keyboard('{ArrowUp}');
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
    });

    it('moves a card by dragging its handle and only saves on drop', async () => {
      await renderRepos();
      const card = (name: string) => screen.getByRole('article', { name: new RegExp(`^octo/${name}:`) });
      const over = vi.spyOn(document, 'elementFromPoint');

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/three' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(card('one'));
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 5, clientY: 5 });

      expect(titles()).toEqual(['octo/three', 'octo/one', 'octo/two']);
      expect(card('three').classList.contains('dragging')).toBe(true);
      expect(savedOrder()).toEqual(['one', 'two', 'three']);

      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(savedOrder()).toEqual(['three', 'one', 'two']);
      expect(card('three').classList.contains('dragging')).toBe(false);

      // Reordering is not a data change, so nothing is refetched.
      await new Promise((r) => setTimeout(r, 500));
      expect(githubGraphql).not.toHaveBeenCalled();
      over.mockRestore();
    });

    it('ignores other pointers and ends a drag released outside the window', async () => {
      await renderRepos();
      const over = vi.spyOn(document, 'elementFromPoint');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/one' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(screen.getByRole('article', { name: /^octo\/two:/ }));
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 5, clientY: 5 });
      fireEvent.pointerCancel(window, { pointerId: 7 });
      expect(titles()).toEqual(['octo/two', 'octo/one', 'octo/three']);

      // Back in the window with no button held: the drop already happened.
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 5, clientY: 5 });
      expect(savedOrder()).toEqual(['two', 'one', 'three']);
      expect(screen.getByRole('article', { name: /^octo\/one:/ }).classList.contains('dragging')).toBe(false);
      over.mockRestore();
    });

    it('cancels a drag with Escape', async () => {
      await renderRepos();
      const over = vi.spyOn(document, 'elementFromPoint');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/one' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(screen.getByRole('article', { name: /^octo\/three:/ }));
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 5, clientY: 5 });
      expect(titles()).toEqual(['octo/two', 'octo/three', 'octo/one']);

      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(titles()).toEqual(['octo/one', 'octo/two', 'octo/three']);
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
      over.mockRestore();
    });
  });

  describe('resizing repo cards', () => {
    const repos = [pinned('octo', 'one'), pinned('octo', 'two')];

    function saved() {
      return JSON.parse(localStorage.getItem('git-dash.config.v1') ?? '{}') as {
        repos: { name: string; widgets: { type: string; limit?: number }[] }[];
        layout: { cardSpans: Record<string, number> };
      };
    }
    const limits = (name: string) =>
      saved().repos.find((r) => r.name === name)!.widgets.flatMap((w) => (w.limit === undefined ? [] : [w.limit]));

    async function renderRepos() {
      vi.mocked(tokens.list).mockResolvedValue(stored(true));
      vi.mocked(githubGraphql).mockReturnValue(new Promise(() => {}));
      saveConfig({ ...defaultConfig(), repos, inbox: { ...defaultConfig().inbox, enabled: false } });
      render(<App />);
      await screen.findByRole('button', { name: 'Resize octo/one' });
    }

    it('changes the width and entry count with the arrow keys', async () => {
      await renderRepos();
      screen.getByRole('button', { name: 'Resize octo/one' }).focus();

      await userEvent.keyboard('{ArrowRight}');
      expect(saved().layout.cardSpans).toEqual({ 'github:octo/one': 2 });
      expect(screen.getByRole('article', { name: /^octo\/one:/ }).style.gridColumn).toBe('span 2');
      expect(screen.getByText('octo/one is 2 columns wide, 5 entries.')).toBeTruthy();

      await userEvent.keyboard('{ArrowDown}{ArrowDown}');
      expect(limits('one')).toEqual([7, 7]);
      expect(limits('two')).toEqual([5, 5]);

      await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
      expect(saved().layout.cardSpans).toEqual({});
      expect(limits('one')).toEqual([6, 6]);
    });

    it('resizes by dragging the grip and only saves on release', async () => {
      await renderRepos();
      const card = screen.getByRole('article', { name: /^octo\/one:/ });
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize octo/one' }), { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
      // Two open lists with 28px rows: 112px down adds two entries to each.
      fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 2, clientY: 112 });

      expect(card.classList.contains('resizing')).toBe(true);
      expect(card.style.gridColumn).toBe('span 2');
      expect(screen.getByText('2 columns · 7 entries')).toBeTruthy();
      expect(limits('one')).toEqual([5, 5]);

      fireEvent.pointerUp(window, { pointerId: 2 });
      expect(saved().layout.cardSpans).toEqual({ 'github:octo/one': 2 });
      expect(limits('one')).toEqual([7, 7]);
      expect(card.classList.contains('resizing')).toBe(false);
    });

    it('cancels a resize with Escape', async () => {
      await renderRepos();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize octo/one' }), { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 2, clientY: 112 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { pointerId: 2 });
      expect(saved().layout.cardSpans).toEqual({});
      expect(limits('one')).toEqual([5, 5]);
    });
  });
});
