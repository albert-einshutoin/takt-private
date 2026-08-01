import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
};

type WorkflowJob = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
};

type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflowPath = resolve('.github/workflows/auto-tag.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowSource) as Workflow;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function findStep(jobName: string, idOrName: string): WorkflowStep {
  const step = workflow.jobs[jobName]?.steps.find(
    candidate => candidate.id === idOrName || candidate.name === idOrName,
  );
  expect(step, `missing ${jobName}/${idOrName} workflow step`).toBeDefined();
  return step as WorkflowStep;
}

function validateRelease(title: string, headRef = 'release/v1.2.3'): string | undefined {
  const script = findStep('validate', 'release').run;
  expect(script).toBeDefined();

  const directory = mkdtempSync(join(tmpdir(), 'takt-auto-tag-validation-'));
  temporaryDirectories.push(directory);
  const outputPath = join(directory, 'github-output');
  writeFileSync(outputPath, '');

  try {
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script as string], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        PR_HEAD_REF: headRef,
        PR_TITLE: title,
      },
      stdio: 'pipe',
    });
  } catch {
    return undefined;
  }

  const tagLine = readFileSync(outputPath, 'utf8')
    .split('\n')
    .find(line => line.startsWith('tag='));
  return tagLine?.slice('tag='.length);
}

describe('auto-tag workflow release boundary', () => {
  it.each([
    ['Release v1.2.3', 'v1.2.3'],
    ['Release v0.6.0-rc1', 'v0.6.0-rc1'],
    ['Release v0.7.0-alpha.1', 'v0.7.0-alpha.1'],
    ['Release v1.2.3+build.7', 'v1.2.3+build.7'],
  ])('accepts the complete release grammar: %s', (title, expectedTag) => {
    expect(validateRelease(title, `release/${expectedTag}`)).toBe(expectedTag);
  });

  it.each([
    ['leading dash', 'Release -v1.2.3'],
    ['newline', 'Release v1.2.3\nprintf PWNED'],
    ['double quote', 'Release v1.2.3"'],
    ['single quote', "Release v1.2.3'"],
    ['command substitution', 'Release v1.2.3$(printf PWNED)'],
    ['backticks', 'Release v1.2.3`printf PWNED`'],
    ['unicode confusable v', 'Release ｖ1.2.3'],
    ['unicode confusable digit', 'Release v１.2.3'],
    ['partial suffix', 'Release v1.2.3 extra'],
    ['partial prefix', 'prefix Release v1.2.3'],
    ['non-release title', 'Fix release automation'],
    ['leading zero', 'Release v01.2.3'],
    ['oversize', `Release v1.2.${'1'.repeat(129)}`],
  ])('rejects %s before any mutation', (_description, title) => {
    expect(validateRelease(title)).toBeUndefined();
  });

  it('rejects a release title when the branch does not exactly match the tag', () => {
    expect(validateRelease('Release v1.2.3', 'release/v9.9.9')).toBeUndefined();
  });

  it('passes untrusted event data through env and keeps mutation jobs gated', () => {
    const runScripts = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .map(step => step.run ?? '')
      .join('\n');

    expect(runScripts).not.toContain('${{ github.event.pull_request.title }}');
    expect(findStep('validate', 'release').env?.PR_TITLE)
      .toBe('${{ github.event.pull_request.title }}');
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.validate?.permissions).toEqual({});
    expect(workflow.jobs.tag?.permissions).toEqual({ contents: 'write' });
    expect(workflow.jobs.publish?.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.tag?.needs).toBe('validate');
    expect(workflow.jobs.publish?.needs).toBe('tag');
    expect(workflow.jobs.validate?.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('uses option-safe, fully qualified tag refspecs in the actual mutation script', () => {
    const script = findStep('tag', 'Create and push tag on PR head commit').run;
    expect(script).toBeDefined();

    const directory = mkdtempSync(join(tmpdir(), 'takt-auto-tag-mutation-'));
    temporaryDirectories.push(directory);
    const gitPath = join(directory, 'git');
    const logPath = join(directory, 'git.log');
    writeFileSync(gitPath, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\n');
    chmodSync(gitPath, 0o755);

    execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script as string], {
      env: {
        ...process.env,
        GIT_LOG: logPath,
        HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RELEASE_TAG: 'v1.2.3',
      },
      stdio: 'pipe',
    });

    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
      'tag -- v1.2.3 0123456789abcdef0123456789abcdef01234567',
      'push -- origin refs/tags/v1.2.3:refs/tags/v1.2.3',
    ]);
  });

  it('does not push or publish when creating the tag fails because it already exists', () => {
    const script = findStep('tag', 'Create and push tag on PR head commit').run;
    expect(script).toBeDefined();

    const directory = mkdtempSync(join(tmpdir(), 'takt-auto-tag-existing-'));
    temporaryDirectories.push(directory);
    const gitPath = join(directory, 'git');
    const logPath = join(directory, 'git.log');
    writeFileSync(
      gitPath,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\n[ "$1" != tag ]\n',
    );
    chmodSync(gitPath, 0o755);

    expect(() => execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script as string],
      {
        env: {
          ...process.env,
          GIT_LOG: logPath,
          HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          RELEASE_TAG: 'v1.2.3',
        },
        stdio: 'pipe',
      },
    )).toThrow();
    expect(readFileSync(logPath, 'utf8').trim()).toBe(
      'tag -- v1.2.3 0123456789abcdef0123456789abcdef01234567',
    );
  });
});
