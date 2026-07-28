import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const developmentNodeVersion = '22.13.1';
const runtimeMinimumNodeVersion = '20.6.0';

function readRequiredFile(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), 'utf-8');
}

function setupNodeVersions(relativePath: string, jobName: string): string[] {
  const workflow = `${readRequiredFile(relativePath)}\n  __end__:\n`;
  const escapedJobName = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jobMatch = workflow.match(
    new RegExp(`^  ${escapedJobName}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n)`, 'm'),
  );
  if (!jobMatch?.[1]) {
    throw new Error(`Missing workflow job: ${jobName}`);
  }

  return [...jobMatch[1].matchAll(/^\s+node-version:\s*['"]?([^'"\s]+)['"]?\s*$/gm)]
    .map((match) => match[1] ?? '');
}

function workflowJob(relativePath: string, jobName: string): string {
  const workflow = `${readRequiredFile(relativePath)}\n  __end__:\n`;
  const escapedJobName = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jobMatch = workflow.match(
    new RegExp(`^  ${escapedJobName}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n)`, 'm'),
  );
  if (!jobMatch?.[1]) {
    throw new Error(`Missing workflow job: ${jobName}`);
  }
  return jobMatch[1];
}

describe('Node toolchain contract', () => {
  it('separates the development baseline from the supported product runtime', () => {
    const packageJson = JSON.parse(readRequiredFile('package.json')) as {
      bin?: Record<string, string>;
      engines?: { node?: string };
      devEngines?: {
        runtime?: { name?: string; version?: string; onFail?: string };
        packageManager?: { name?: string; version?: string; onFail?: string };
      };
      packageManager?: string;
    };

    expect(packageJson.engines?.node).toBe('>=20.6.0');
    expect(packageJson.devEngines?.runtime).toEqual({
      name: 'node',
      version: '^20.19.0 || ^22.13.0 || >=24',
      onFail: 'error',
    });
    expect(packageJson.devEngines?.packageManager).toEqual({
      name: 'npm',
      version: '10.9.2',
      onFail: 'error',
    });
    expect(packageJson.packageManager).toBe('npm@10.9.2');
    expect(packageJson.bin).toMatchObject({
      takt: './bin/takt.js',
      'takt-dev': './bin/takt.js',
    });
  });

  it('runs source development checks on the exact Node baseline', () => {
    expect(setupNodeVersions('.github/workflows/ci.yml', 'lint')).toEqual([developmentNodeVersion]);
    expect(setupNodeVersions('.github/workflows/ci.yml', 'test')).toEqual([developmentNodeVersion]);
    expect(setupNodeVersions('.github/workflows/ci.yml', 'e2e-mock')).toEqual([developmentNodeVersion]);
    expect(setupNodeVersions('.github/workflows/dependency-check.yml', 'fresh-install'))
      .toEqual([developmentNodeVersion]);
    expect(setupNodeVersions('.github/workflows/auto-tag.yml', 'publish'))
      .toEqual([developmentNodeVersion]);
    expect(setupNodeVersions('.github/workflows/pr-comment-commands.yml', 'ci'))
      .toEqual([developmentNodeVersion]);

    // These jobs consume the already-published CLI rather than developing the source.
    expect(setupNodeVersions('.github/workflows/pr-comment-commands.yml', 'review')).toEqual(['20']);
    expect(setupNodeVersions('.github/workflows/pr-comment-commands.yml', 'resolve')).toEqual(['20']);
  });

  it('smoke tests the packed production CLI at the advertised runtime minimum', () => {
    const runtimeSmoke = workflowJob('.github/workflows/ci.yml', 'runtime-smoke');

    expect(setupNodeVersions('.github/workflows/ci.yml', 'runtime-smoke'))
      .toEqual([developmentNodeVersion, runtimeMinimumNodeVersion]);
    expect(runtimeSmoke).toContain('npm pack');
    expect(runtimeSmoke).toContain('npm install --omit=dev');
    expect(runtimeSmoke).toContain('NO_UPDATE_NOTIFIER=1');
    expect(runtimeSmoke).toContain('--version');
  });

  it('pins container development environments while keeping Nix on Node 22', () => {
    const dockerfile = readRequiredFile('Dockerfile');
    const devcontainer = JSON.parse(readRequiredFile('.devcontainer/devcontainer.json')) as {
      image?: string;
    };
    const flake = readRequiredFile('flake.nix');
    const nvmVersion = readRequiredFile('.nvmrc').trim();

    expect(dockerfile).toContain('FROM node:22.13.1-alpine');
    expect(devcontainer.image).toBe('node:22.13.1-bookworm');
    expect(flake).toContain('nodejs = pkgs.nodejs_22');
    expect(nvmVersion).toBe(developmentNodeVersion);
  });

  it('documents development and runtime Node requirements in both languages', () => {
    const english = readRequiredFile('CONTRIBUTING.md');
    const japanese = readRequiredFile('docs/CONTRIBUTING.ja.md');

    for (const document of [english, japanese]) {
      expect(document).toContain('22.13.1');
      expect(document).toContain('npm 10.9.2');
      expect(document).toContain('20.6.0');
    }
  });
});
