import { openUrl } from '@tauri-apps/plugin-opener';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SCRIPT_URL } from '../test/fixtures';
import { ExternalLink } from './ExternalLink';

describe('ExternalLink', () => {
  it('opens GitHub URLs in the system browser', async () => {
    render(<ExternalLink href="https://github.com/octo/repo/pull/1">PR</ExternalLink>);
    const link = screen.getByRole('link', { name: 'PR' });
    expect(link.getAttribute('href')).toBe('https://github.com/octo/repo/pull/1');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');

    await userEvent.click(link);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/octo/repo/pull/1');
    // The webview itself must not navigate.
    expect(window.location.href).not.toContain('github.com');
  });

  it.each([
    SCRIPT_URL,
    'https://evil.example/octo/repo',
    'https://github.com.evil.example/x',
    'http://github.com/octo/repo',
    'data:text/html,<script>alert(1)</script>',
    '',
  ])('renders %j as plain text and never opens it', async (href) => {
    const { container } = render(<ExternalLink href={href}>text</ExternalLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('a')).toBeNull();

    await userEvent.click(screen.getByText('text'));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
