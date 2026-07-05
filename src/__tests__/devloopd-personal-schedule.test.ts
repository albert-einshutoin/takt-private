import { describe, expect, it } from 'vitest';
import {
  formatPersonalScheduleReport,
  runPersonalScheduleTemplates,
} from '../devloopd/personalSchedule.js';

const PRIVATE_PATH_PATTERNS = [
  '/Volumes/Satechi',
  '/Users/shutoide',
  'sk-secret-test',
  'OPENAI_API_KEY',
];

function expectNoPrivateLocalLeak(value: string): void {
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    expect(value).not.toContain(pattern);
  }
}

describe('devloopd personal schedule templates', () => {
  it('renders launchd and cron templates with bounded safe defaults', () => {
    const report = runPersonalScheduleTemplates({
      repoPath: '/tmp/takt personal repo',
      repo: 'owner/private-takt',
    });
    const combined = [
      report.command,
      ...report.templates.map((template) => template.content),
    ].join('\n');

    expect(report.templates.map((template) => template.kind)).toEqual(['launchd', 'cron']);
    expect(combined).toContain('npm');
    expect(combined).toContain('check:personal');
    expect(combined).toContain('recover-stale');
    expect(combined).toContain('staged');
    expect(combined).toContain('loop');
    expect(combined).toContain('--safety-profile');
    expect(combined).toContain('safe-default');
    expect(combined).toContain('--max-cycles');
    expect(combined).toContain('1');
    expect(combined).toContain('TAKT_LOOP_GH_TIMEOUT_MS');
    expect(combined).toContain('/tmp/takt personal repo/.devloop/logs');
    expect(combined).toContain('owner/private-takt');
    expectNoPrivateLocalLeak(combined);
  });

  it('documents install, uninstall, status, and dry-run commands', () => {
    const report = runPersonalScheduleTemplates({
      repoPath: '/tmp/takt-scheduler',
      repo: 'owner/repo',
      kind: 'launchd',
      intervalSeconds: 1800,
      label: 'com.takt.devloopd.owner-repo',
    });
    const text = formatPersonalScheduleReport(report);

    expect(text).toContain('Install:');
    expect(text).toContain('Status:');
    expect(text).toContain('Uninstall:');
    expect(text).toContain('Dry-run command:');
    expect(text).toContain('launchctl bootstrap');
    expect(text).toContain('launchctl bootout');
    expect(text).toContain('launchctl print');
    expect(text).toContain('<key>StartInterval</key>');
    expect(text).toContain('<integer>1800</integer>');
    expectNoPrivateLocalLeak(text);
  });

  it('renders a cron-only template with explicit shell environment and known log path', () => {
    const report = runPersonalScheduleTemplates({
      repoPath: '/tmp/takt-cron',
      repo: 'owner/repo',
      kind: 'cron',
      cronSchedule: '*/30 * * * *',
      shellPath: '/bin/bash',
      pathEnv: '/opt/takt/bin:/usr/bin:/bin',
    });
    const [template] = report.templates;

    expect(template?.kind).toBe('cron');
    expect(template?.content).toContain('*/30 * * * *');
    expect(template?.content).toContain("PATH='/opt/takt/bin:/usr/bin:/bin'");
    expect(template?.content).toContain("'/bin/bash' '-lc'");
    expect(template?.content).toContain('/tmp/takt-cron/.devloop/logs/personal-automation.cron.log');
    expect(template?.installCommands.join('\n')).toContain('crontab -');
    expect(template?.installCommands.join('\n')).toContain("--path-env' '/opt/takt/bin:/usr/bin:/bin");
    expect(template?.installCommands.join('\n')).toContain("--shell' '/bin/bash");
    expectNoPrivateLocalLeak(template?.content ?? '');
  });

  it('escapes shell-sensitive paths instead of interpolating raw commands', () => {
    const report = runPersonalScheduleTemplates({
      repoPath: "/tmp/takt repo's copy",
      repo: 'owner/repo',
      kind: 'cron',
    });

    expect(report.command).toContain("'\\''");
    expect(report.command).toContain("cd '/tmp/takt repo'\\''s copy'");
    expect(report.templates[0]?.content).toContain("\\''");
    expect(report.templates[0]?.content).toContain('takt repo');
    expect(report.templates[0]?.content).not.toContain('copy;');
  });

  it('rejects unbounded schedule values', () => {
    expect(() => runPersonalScheduleTemplates({ intervalSeconds: 0 })).toThrow('intervalSeconds');
    expect(() => runPersonalScheduleTemplates({ maxCycles: -1 })).toThrow('maxCycles');
    expect(() => runPersonalScheduleTemplates({ ghTimeoutMs: 0 })).toThrow('ghTimeoutMs');
    expect(() => runPersonalScheduleTemplates({ label: 'bad label; rm -rf /' })).toThrow('label');
  });
});
