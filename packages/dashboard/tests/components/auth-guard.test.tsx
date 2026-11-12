import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Session } from 'next-auth';
import { AuthGuard } from '@/components/layout/auth-guard';

const state = vi.hoisted(() => ({ session: null as Session | null, replace: vi.fn(), signOut: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: state.session, status: 'authenticated' }), signOut: state.signOut }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: state.replace }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const githubSession = {
  expires: '2099-01-01',
  user: { id: 1, principalId: 'p', sessionVersion: 1, login: 'tester', isSuperadmin: false, orgs: [] },
} as Session;

describe('GitHub installation onboarding', () => {
  it('uses the real App fallback and does not redirect to GitHub automatically', () => {
    state.session = githubSession;
    render(<AuthGuard>Protected content</AuthGuard>);
    expect(screen.getByRole('link', { name: 'Install on GitHub' }).getAttribute('href')).toBe('https://github.com/apps/fluent-flow/installations/new');
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('uses runtime preview App metadata and explains existing-installation isolation', () => {
    state.session = { ...githubSession, githubApp: { installUrl: 'https://github.com/apps/fluent-flow-preview/installations/new', preview: true } };
    render(<AuthGuard>Protected content</AuthGuard>);
    expect(screen.getByRole('link', { name: 'Open Preview App on GitHub' }).getAttribute('href')).toBe('https://github.com/apps/fluent-flow-preview/installations/new');
    expect(screen.getByText(/separate from your production installation/)).toBeTruthy();
    expect(screen.getByText(/connect its existing installation to this preview/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Install on GitHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(state.signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('keeps collaboration-only users with no orgs in their workspace', () => {
    state.session = { ...githubSession, user: { ...githubSession.user, id: null } };
    render(<AuthGuard>Protected content</AuthGuard>);
    expect(screen.getByText('Protected content')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
