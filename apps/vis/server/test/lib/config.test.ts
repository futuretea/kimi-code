import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { hostForUrl, resolveKimiCodeHome } from '../../src/config';
import { formatStartupBanner } from '../../src/startup-banner';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile), readdir: vi.fn(fs.readdir) };
});

const read = vi.mocked(readFile);
const list = vi.mocked(readdir);

describe('resolveKimiCodeHome', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { tea: undefined, kimi: undefined },
    { tea: '/tmp/tea-vis', kimi: undefined },
    { tea: undefined, kimi: '/tmp/kimi-vis' },
    { tea: '/tmp/tea-vis', kimi: '/tmp/kimi-vis' },
  ])('isolates the user home for $tea and $kimi', ({ tea, kimi }) => {
    vi.stubEnv('TEA_CODE_HOME', tea);
    vi.stubEnv('KIMI_CODE_HOME', kimi);
    expect(resolveKimiCodeHome()).toBe(tea ?? join(homedir(), '.tea-code'));
  });

  it('displays the Tea home variable in the startup banner', () => {
    expect(formatStartupBanner({ host: '127.0.0.1', port: 3001, kimiCodeHome: '/tmp/tea-vis' })).toBe(
      '[vis-server] listening on http://127.0.0.1:3001 (auth=disabled, TEA_CODE_HOME=/tmp/tea-vis)\n',
    );
  });

  it.each([
    { tea: false, kimi: false },
    { tea: true, kimi: false },
    { tea: false, kimi: true },
    { tea: true, kimi: true },
  ])('reads only Tea sessions for tea=$tea and kimi=$kimi', async ({ tea, kimi }) => {
    const root = await mkdtemp(join(tmpdir(), 'vis-home-isolation-'));
    try {
      vi.stubEnv('HOME', root);
      vi.stubEnv('USERPROFILE', root);
      const homes = [
        join(root, '.tea-code'),
        join(root, 'custom-tea'),
        join(root, '.kimi-code'),
        join(root, 'custom-kimi'),
      ];
      vi.stubEnv('TEA_CODE_HOME', tea ? homes[1] : undefined);
      vi.stubEnv('KIMI_CODE_HOME', kimi ? homes[3] : undefined);
      for (const [index, home] of homes.entries()) {
        const sessionDir = join(home, 'sessions', 'workspace', `session_${index}`);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ title: `session ${index}`, agents: {} }));
      }
      const upstreamPaths = homes.slice(2).map((home, index) => join(home, 'sessions', 'workspace', `session_${index + 2}`, 'state.json'));
      const upstreamBytes = await Promise.all(upstreamPaths.map((path) => readFile(path)));
      vi.resetModules();
      const { sessionsRoute } = await import('../../src/routes/sessions');
      read.mockClear();
      list.mockClear();

      const response = await sessionsRoute().request('/');

      const expectedIndex = tea ? 1 : 0;
      const expectedHome = homes[expectedIndex]!;
      expect(response.status).toBe(200);
      const body = await response.json() as { sessions: { sessionId: string }[] };
      expect(body.sessions.map((session) => session.sessionId)).toEqual([`session_${expectedIndex}`]);
      const accessed = [
        ...read.mock.calls.map(([path]) => path),
        ...list.mock.calls.map(([path]) => path),
      ];
      expect(accessed).toContain(join(expectedHome, 'sessions'));
      expect(accessed.every((path) => (path as string).startsWith(`${expectedHome}${sep}`))).toBe(true);
      expect(await Promise.all(upstreamPaths.map((path) => readFile(path)))).toEqual(upstreamBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('hostForUrl', () => {
  it('brackets a bare IPv6 literal for use in a URL', () => {
    expect(hostForUrl('::1')).toBe('[::1]');
  });

  it('leaves an IPv4 literal unchanged', () => {
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1');
  });

  it('leaves a hostname unchanged', () => {
    expect(hostForUrl('localhost')).toBe('localhost');
  });

  it('leaves an already-bracketed IPv6 literal unchanged', () => {
    expect(hostForUrl('[::1]')).toBe('[::1]');
  });
});
