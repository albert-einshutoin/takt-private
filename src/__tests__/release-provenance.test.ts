import { describe, expect, it } from 'vitest';
import {
  collectReleaseProvenance,
  formatReleaseProvenance,
} from '../shared/utils/releaseProvenance.js';

const packageInfo = { name: 'takt', version: '1.2.3' };
const now = () => new Date('2026-07-06T00:00:00.000Z');

describe('release provenance', () => {
  it('prefers explicit build commit environment metadata', () => {
    const provenance = collectReleaseProvenance({
      packageInfo,
      packageRoot: '/tmp/takt',
      now,
      env: { TAKT_BUILD_COMMIT: 'abcdef1234567890' },
      gitCommand: () => undefined,
    });

    expect(provenance).toMatchObject({
      packageName: 'takt',
      packageVersion: '1.2.3',
      commitSha: 'abcdef1234567890',
      commitSource: 'TAKT_BUILD_COMMIT',
      gitDirty: null,
      generatedAt: '2026-07-06T00:00:00.000Z',
    });
  });

  it('falls back to git commit and dirty state when env metadata is absent', () => {
    const provenance = collectReleaseProvenance({
      packageInfo,
      packageRoot: '/tmp/takt',
      now,
      env: {},
      gitCommand(args) {
        if (args.join(' ') === 'rev-parse HEAD') {
          return '0123456789abcdef0123456789abcdef01234567';
        }
        if (args.join(' ') === 'status --porcelain') {
          return ' M package.json';
        }
        return undefined;
      },
    });

    expect(provenance.commitSha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(provenance.commitSource).toBe('git');
    expect(provenance.gitDirty).toBe(true);
  });

  it('marks commit as unknown when no valid metadata source exists', () => {
    const provenance = collectReleaseProvenance({
      packageInfo,
      packageRoot: '/tmp/takt',
      now,
      env: { GITHUB_SHA: 'not-a-sha' },
      gitCommand: () => undefined,
    });

    expect(provenance.commitSha).toBe('unknown');
    expect(provenance.commitSource).toBe('unknown');
    expect(formatReleaseProvenance(provenance)).toContain('Commit: unknown (unknown)');
  });

  it('renders artifact boundary and runtime metadata for release notes', () => {
    const provenance = collectReleaseProvenance({
      packageInfo,
      packageRoot: '/tmp/takt',
      now,
      env: { SOURCE_COMMIT: '1234567890abcdef' },
      gitCommand: () => '',
    });
    const text = formatReleaseProvenance(provenance);

    expect(text).toContain('takt 1.2.3');
    expect(text).toContain('Commit: 1234567890abcdef (SOURCE_COMMIT)');
    expect(text).toContain('Artifact boundary:');
    expect(text).toContain('npm package build from dist/');
    expect(text).toContain('Runtime:');
  });
});
