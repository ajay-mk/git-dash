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
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 5, clientY: 5 });

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

    it('cancels a drag with Escape', async () => {
      await renderRepos();
      const over = vi.spyOn(document, 'elementFromPoint');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Reorder octo/one' }), { button: 0, pointerId: 1 });
      over.mockReturnValue(screen.getByRole('article', { name: /^octo\/three:/ }));
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 5, clientY: 5 });
      expect(titles()).toEqual(['octo/two', 'octo/three', 'octo/one']);

      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(titles()).toEqual(['octo/one', 'octo/two', 'octo/three']);
      expect(savedOrder()).toEqual(['one', 'two', 'three']);
      over.mockRestore();
    });
  });
});
