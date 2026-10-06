import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultConfig } from './config/schema';
import { AppError, githubGraphql, tokens } from './lib/transport';
import { pinned } from './test/fixtures';

const DASHBOARD = { name: 'Pin your first repository' };

function saveConfig(config = defaultConfig()) {
  localStorage.setItem('git-dash.config.v1', JSON.stringify(config));
}

describe('App', () => {
  it('shows token setup when no token is stored', async () => {
    vi.mocked(tokens.status).mockResolvedValue(false);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(tokens.status).toHaveBeenCalledWith('github');
    expect(githubGraphql).not.toHaveBeenCalled();
  });

  it('shows the keychain error on the setup screen', async () => {
    vi.mocked(tokens.status).mockRejectedValue(new AppError('keyring', 'The keychain is locked.'));
    render(<App />);
    expect(await screen.findByText('The keychain is locked.')).toBeTruthy();
  });

  it('shows the dashboard when a token is stored', async () => {
    vi.mocked(tokens.status).mockResolvedValue(true);
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    expect(await screen.findByRole('heading', DASHBOARD)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('returns to token setup when GitHub rejects the token', async () => {
    vi.mocked(tokens.status).mockResolvedValue(true);
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
    vi.mocked(tokens.status).mockResolvedValue(true);
    vi.mocked(githubGraphql).mockRejectedValue(new AppError('network', 'Could not reach GitHub.'));
    saveConfig({ ...defaultConfig(), repos: [pinned()] });
    render(<App />);

    // Shown in the banner and in the sidebar.
    expect((await screen.findAllByText('Could not reach GitHub.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Connect GitHub' })).toBeNull();
  });

  it('removing the token clears it and shows token setup', async () => {
    vi.mocked(tokens.status).mockResolvedValue(true);
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove token' }));

    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeTruthy();
    expect(tokens.clear).toHaveBeenCalledExactlyOnceWith('github');
  });

  it('persists settings changes', async () => {
    vi.mocked(tokens.status).mockResolvedValue(true);
    saveConfig({ ...defaultConfig(), inbox: { ...defaultConfig().inbox, enabled: false } });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'Dark');

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(JSON.parse(localStorage.getItem('git-dash.config.v1')!)).toMatchObject({ theme: 'dark' });
  });
});
