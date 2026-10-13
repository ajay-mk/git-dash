import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppError, tokens } from '../lib/transport';
import { TokenSetup } from './TokenSetup';

const TOKEN = 'github_pat_SECRET123';

function setup(props: Partial<Parameters<typeof TokenSetup>[0]> = {}) {
  const onDone = vi.fn();
  const view = render(<TokenSetup onDone={onDone} {...props} />);
  const input = screen.getByLabelText('Access token') as HTMLInputElement;
  const submit = screen.getByRole('button', { name: 'Save token' });
  return { ...view, onDone, input, submit };
}

describe('TokenSetup', () => {
  it('stores the token through the backend and reports the login', async () => {
    vi.mocked(tokens.set).mockResolvedValue('octocat');
    const { input, submit, onDone, container } = setup();

    expect(input.type).toBe('password');
    expect(submit.hasAttribute('disabled')).toBe(true);
    await userEvent.type(input, TOKEN);
    await userEvent.click(submit);

    expect(tokens.set).toHaveBeenCalledExactlyOnceWith('github', TOKEN);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('octocat', 'github'));
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('shows backend errors without echoing the token', async () => {
    vi.mocked(tokens.set).mockRejectedValue(new AppError('unauthorized', 'GitHub rejected this token.'));
    const { input, submit, onDone, container } = setup();

    await userEvent.type(input, TOKEN);
    await userEvent.click(submit);

    expect((await screen.findByRole('alert')).textContent).toBe('GitHub rejected this token.');
    expect(onDone).not.toHaveBeenCalled();
    // The value stays in the password field for a retry, but appears nowhere
    // in the markup, including the input's value attribute.
    expect(input.value).toBe(TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('keeps the token out of the markup while typing', async () => {
    const { input, container } = setup();
    await userEvent.type(input, TOKEN);
    expect(input.getAttribute('value') ?? '').not.toContain('SECRET');
    expect(container.innerHTML).not.toContain('SECRET');
  });

  it('disables the button while verifying', async () => {
    let resolve: (login: string) => void = () => {};
    vi.mocked(tokens.set).mockReturnValue(new Promise((r) => (resolve = r)));
    const { input, submit } = setup();

    await userEvent.type(input, TOKEN);
    await userEvent.click(submit);
    expect(screen.getByRole('button', { name: 'Verifying…' }).hasAttribute('disabled')).toBe(true);

    resolve('octocat');
    await waitFor(() => expect(submit.textContent).toBe('Save token'));
  });

  it('keeps the button disabled for whitespace-only input', async () => {
    const { input, submit } = setup();
    await userEvent.type(input, '   ');
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('shows the reason and an optional cancel button', async () => {
    const onCancel = vi.fn();
    setup({ reason: 'Your token was rejected.', onCancel });
    expect(screen.getByText('Your token was rejected.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(tokens.set).not.toHaveBeenCalled();
  });

  it('links to a prefilled token form and lists the permissions', () => {
    setup();
    const link = screen.getByRole('link', { name: 'Create a fine-grained token' });
    const url = new URL(link.getAttribute('href')!);
    expect(url.pathname).toBe('/settings/personal-access-tokens/new');
    expect(url.searchParams.get('pull_requests')).toBe('read');
    expect(link.closest('li')?.textContent).toContain('Metadata, Contents, Pull requests, Issues, Commit statuses and Actions');
  });

  describe('GitLab', () => {
    const GL_TOKEN = 'glpat-SECRET0123456789';

    async function chooseGitLab() {
      const view = setup();
      await userEvent.click(screen.getByRole('button', { name: 'GitLab' }));
      expect(screen.getByRole('heading', { name: 'Connect GitLab' })).toBeTruthy();
      return view;
    }

    it('stores a gitlab.com token by default', async () => {
      vi.mocked(tokens.set).mockResolvedValue('jane.doe');
      const { input, submit, onDone, container } = await chooseGitLab();
      expect(screen.getByRole('button', { name: 'GitLab' }).getAttribute('aria-pressed')).toBe('true');
      await userEvent.type(input, GL_TOKEN);
      await userEvent.click(submit);
      expect(tokens.set).toHaveBeenCalledExactlyOnceWith('gitlab', GL_TOKEN, null, 'gitlab.com');
      await waitFor(() => expect(onDone).toHaveBeenCalledWith('jane.doe', 'gitlab'));
      expect(container.innerHTML).not.toContain('SECRET');
    });

    it('sends a self-hosted instance in its normalized form', async () => {
      vi.mocked(tokens.set).mockResolvedValue('jane.doe');
      const { input, submit } = await chooseGitLab();
      const host = screen.getByRole('textbox', { name: 'GitLab instance' });
      await userEvent.clear(host);
      await userEvent.type(host, 'https://GitLab.Example.com:8443/');
      // The token page is shown as text: only connected instances can be opened.
      expect(screen.getByText(/gitlab\.example\.com:8443\/-\/user_settings\/personal_access_tokens/)).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Create a personal access token' })).toBeNull();
      await userEvent.type(input, GL_TOKEN);
      await userEvent.click(submit);
      expect(tokens.set).toHaveBeenCalledExactlyOnceWith('gitlab', GL_TOKEN, null, 'gitlab.example.com:8443');
    });

    it('refuses an instance address it cannot use', async () => {
      const { input, submit, onDone } = await chooseGitLab();
      const host = screen.getByRole('textbox', { name: 'GitLab instance' });
      await userEvent.clear(host);
      await userEvent.type(host, 'http://gitlab.example.com');
      await userEvent.type(input, GL_TOKEN);
      await userEvent.click(submit);
      expect(screen.getByRole('alert').textContent).toContain('Enter the address of your GitLab instance');
      expect(tokens.set).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    });

    it('links to the prefilled token form on gitlab.com', async () => {
      await chooseGitLab();
      const link = screen.getByRole('link', { name: 'Create a personal access token' });
      const url = new URL(link.getAttribute('href')!);
      expect(url.host).toBe('gitlab.com');
      expect(url.searchParams.get('scopes')).toBe('read_api');
    });

    it('can open on GitLab', () => {
      render(<TokenSetup provider="gitlab" onDone={vi.fn()} />);
      expect(screen.getByRole('heading', { name: 'Connect GitLab' })).toBeTruthy();
    });
  });
});
