import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean | number>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
};

type Workflow = {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type ScriptResult = {
  success: boolean;
  commandLog: string;
  githubEnv: string;
  githubOutput: string;
  networkLog: string;
  sentinelExists: boolean;
};

const EXEC_TIMEOUT_MS = 3_000;
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const MERGE_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const ACTION_PINS = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  downloadArtifact: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
} as const;
const workflowPath = resolve('.github/workflows/auto-tag.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowSource) as Workflow;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function findStep(jobName: string, idOrName: string): WorkflowStep {
  const step = workflow.jobs[jobName]?.steps.find(
    candidate => candidate.id === idOrName || candidate.name === idOrName,
  );
  expect(step, `missing ${jobName}/${idOrName} workflow step`).toBeDefined();
  return step as WorkflowStep;
}

function installCommandSentinels(directory: string): {
  commandLogPath: string;
  networkLogPath: string;
} {
  const bin = join(directory, 'bin');
  execFileSync('/bin/mkdir', ['-p', bin], { timeout: EXEC_TIMEOUT_MS });
  const commandLogPath = join(directory, 'commands.log');
  const networkLogPath = join(directory, 'network.log');
  writeFileSync(commandLogPath, '');
  writeFileSync(networkLogPath, '');
  for (const command of ['git', 'npm', 'touch']) {
    const executable = join(bin, command);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${command} $*' >> "$COMMAND_LOG"\n`);
    chmodSync(executable, 0o755);
  }
  for (const command of ['curl', 'wget', 'nc']) {
    const executable = join(bin, command);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${command} $*' >> "$NETWORK_LOG"\n`);
    chmodSync(executable, 0o755);
  }
  return { commandLogPath, networkLogPath };
}

function runScript(
  script: string,
  directory: string,
  environment: Record<string, string>,
): ScriptResult {
  const githubEnvPath = join(directory, 'github-env');
  const githubOutputPath = join(directory, 'github-output');
  const sentinelPath = join(directory, 'sentinel');
  writeFileSync(githubEnvPath, '');
  writeFileSync(githubOutputPath, '');
  const { commandLogPath, networkLogPath } = installCommandSentinels(directory);
  let success = true;
  try {
    execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
      {
        cwd: directory,
        env: {
          ...process.env,
          ...environment,
          COMMAND_LOG: commandLogPath,
          GITHUB_ENV: githubEnvPath,
          GITHUB_OUTPUT: githubOutputPath,
          NETWORK_LOG: networkLogPath,
          PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
          SENTINEL_PATH: sentinelPath,
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error
      && error.code === 'ETIMEDOUT') {
      throw error;
    }
    success = false;
  }
  return {
    success,
    commandLog: readFileSync(commandLogPath, 'utf8'),
    githubEnv: readFileSync(githubEnvPath, 'utf8'),
    githubOutput: readFileSync(githubOutputPath, 'utf8'),
    networkLog: readFileSync(networkLogPath, 'utf8'),
    sentinelExists: existsSync(sentinelPath),
  };
}

function validateRelease(title: string, headRef = 'release/v1.2.3'): ScriptResult {
  const script = findStep('validate', 'release').run;
  expect(script).toBeDefined();
  return runScript(script as string, createTemporaryDirectory('takt-auto-tag-title-'), {
    PR_HEAD_REF: headRef,
    PR_TITLE: title,
  });
}

function validatePackage(
  version: string,
  releaseVersion = '1.2.3',
  options: {
    readonly name?: string;
    readonly npmDistTag?: 'latest' | 'next';
    readonly environment?: Record<string, string>;
  } = {},
): ScriptResult {
  const script = findStep('validate', 'package').run;
  expect(script).toBeDefined();
  const directory = createTemporaryDirectory('takt-auto-tag-package-');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: options.name ?? 'takt', version,
  }));
  return runScript(script as string, directory, {
    MERGE_COMMIT_SHA: MERGE_SHA,
    NPM_DIST_TAG: options.npmDistTag ?? 'latest',
    RELEASE_TAG: `v${releaseVersion}`,
    RELEASE_VERSION: releaseVersion,
    ...options.environment,
  });
}

function outputMap(output: string): Record<string, string> {
  return Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

describe('auto-tag workflow release boundary', () => {
  it.each([
    ['Release v1.2.3', 'v1.2.3', 'latest'],
    ['Release v0.6.0-rc1', 'v0.6.0-rc1', 'next'],
    ['Release v0.7.0-alpha.1', 'v0.7.0-alpha.1', 'next'],
    ['Release v1.2.3+build.7', 'v1.2.3+build.7', 'latest'],
    ['Release v1.2.3+build-7', 'v1.2.3+build-7', 'latest'],
    ['Release v1.2.3-alpha+build-7', 'v1.2.3-alpha+build-7', 'next'],
    [
      'Release v1.2.3-foo-1+9007199254740992',
      'v1.2.3-foo-1+9007199254740992',
      'next',
    ],
  ])('accepts the complete release grammar: %s', (title, expectedTag, expectedNpmTag) => {
    const result = validateRelease(title, `release/${expectedTag}`);
    expect(result.success).toBe(true);
    expect(result.githubOutput).toBe('');
    expect(outputMap(result.githubEnv)).toEqual({
      NPM_DIST_TAG: expectedNpmTag,
      RELEASE_TAG: expectedTag,
      RELEASE_VERSION: expectedTag.slice(1),
    });
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
    ['core leading zero', 'Release v01.2.3'],
    ['numeric prerelease leading zero', 'Release v1.2.3-01'],
    ['empty prerelease', 'Release v1.2.3-'],
    ['empty prerelease identifier', 'Release v1.2.3-alpha..1'],
    ['trailing prerelease identifier', 'Release v1.2.3-alpha.'],
    ['consecutive build identifiers', 'Release v1.2.3+build..7'],
    ['empty build metadata', 'Release v1.2.3+'],
    ['oversize', `Release v1.2.${'1'.repeat(129)}`],
  ])('rejects %s with no output, command, or network effect', (_description, title) => {
    const result = validateRelease(title);
    expect(result).toMatchObject({
      success: false,
      commandLog: '',
      githubEnv: '',
      githubOutput: '',
      networkLog: '',
      sentinelExists: false,
    });
  });

  it.each([
    '9007199254740992.0.0',
    '1.2.3-9007199254740992',
    '1.2.3-foo-1.9007199254740992',
    '1.2.3-alpha-beta.9007199254740992+build.7',
  ])('rejects npm-unsafe numeric SemVer with a matching release branch: %s', (version) => {
    const result = validateRelease(`Release v${version}`, `release/v${version}`);
    expect(result).toMatchObject({ success: false, githubEnv: '', githubOutput: '' });
  });

  it('treats a sentinel command in the title as inert data', () => {
    const directory = createTemporaryDirectory('takt-auto-tag-sentinel-title-');
    const sentinel = join(directory, 'title-sentinel');
    const script = findStep('validate', 'release').run;
    expect(script).toBeDefined();
    const result = runScript(script as string, directory, {
      PR_HEAD_REF: 'release/v1.2.3',
      PR_TITLE: `Release v1.2.3$(touch ${sentinel})`,
    });
    expect(result.success).toBe(false);
    expect(result.githubOutput).toBe('');
    expect(result.githubEnv).toBe('');
    expect(result.commandLog).toBe('');
    expect(result.networkLog).toBe('');
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    ['node', '$(node -e "require(\'node:fs\').writeFileSync(process.env.SENTINEL_PATH, \'x\')")'],
    ['python', '$(python3 -c "import os; open(os.environ[\'SENTINEL_PATH\'], \'w\').write(\'x\')")'],
    ['dev-tcp', '$(printf x >/dev/tcp/127.0.0.1/9; touch "$SENTINEL_PATH")'],
  ])('keeps %s execution syntax inert without claiming an OS network sandbox', (
    _description,
    payload,
  ) => {
    const result = validateRelease(`Release v1.2.3${payload}`);
    expect(result).toMatchObject({
      success: false,
      commandLog: '',
      githubEnv: '',
      githubOutput: '',
      networkLog: '',
      sentinelExists: false,
    });
  });

  it('fails the test harness when a workflow script exceeds its deadline', () => {
    expect(() => runScript(
      'sleep 10',
      createTemporaryDirectory('takt-auto-tag-timeout-'),
      {},
    )).toThrow();
  });

  it('rejects a release title when the branch does not exactly match the tag', () => {
    const result = validateRelease('Release v1.2.3', 'release/v9.9.9');
    expect(result.success).toBe(false);
    expect(result.githubOutput).toBe('');
    expect(result.githubEnv).toBe('');
  });

  it('binds package name, package version, commit, tag, and npm dist-tag once', () => {
    const result = validatePackage('1.2.3');
    expect(result.success).toBe(true);
    expect(outputMap(result.githubOutput)).toEqual({
      commit: MERGE_SHA,
      npm_dist_tag: 'latest',
      package_name: 'takt',
      package_version: '1.2.3',
      tag: 'v1.2.3',
    });
    expect(result.commandLog).toBe('');
    expect(result.networkLog).toBe('');
  });

  it.each([
    ['1.2.3+build-7', 'latest'],
    ['1.2.3-alpha+build-7', 'next'],
  ] as const)('independently binds %s to the expected dist-tag %s', (version, npmDistTag) => {
    const result = validatePackage(version, version, { npmDistTag });
    expect(result.success).toBe(true);
    expect(outputMap(result.githubOutput).npm_dist_tag).toBe(npmDistTag);
  });

  it.each([
    ['higher package version', '9.9.9'],
    ['lower package version', '1.2.2'],
    ['prerelease mismatch', '1.2.3-rc.1'],
  ])('rejects %s before any release output or mutation', (_description, version) => {
    const result = validatePackage(version);
    expect(result).toMatchObject({
      success: false,
      commandLog: '',
      githubOutput: '',
      networkLog: '',
      sentinelExists: false,
    });
  });

  it.each([
    ['package name', { name: '@attacker/takt' }],
    ['merge commit', { environment: { MERGE_COMMIT_SHA: 'deadbeef' } }],
    ['release tag', { environment: { RELEASE_TAG: 'v9.9.9' } }],
    ['npm dist-tag', { environment: { NPM_DIST_TAG: 'next' } }],
  ] as const)('rejects a mismatched %s before exposing the release tuple', (
    _description,
    options,
  ) => {
    const result = validatePackage('1.2.3', '1.2.3', options);
    expect(result).toMatchObject({
      success: false,
      commandLog: '',
      githubOutput: '',
      networkLog: '',
      sentinelExists: false,
    });
  });

  it('treats a sentinel command in package metadata as inert data', () => {
    const result = validatePackage('1.2.3$(touch "$SENTINEL_PATH")');
    expect(result).toMatchObject({
      success: false,
      commandLog: '',
      githubOutput: '',
      networkLog: '',
      sentinelExists: false,
    });
  });

  it('checks out package.json from the exact merged main commit, not the PR head', () => {
    const checkout = findStep('validate', 'Read package metadata from merged commit');
    expect(checkout.uses).toBe(ACTION_PINS.checkout);
    expect(checkout.with).toMatchObject({
      'persist-credentials': false,
      ref: '${{ github.event.pull_request.merge_commit_sha }}',
      'sparse-checkout': 'package.json',
      'sparse-checkout-cone-mode': false,
    });
    const allCheckouts = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .filter(step => step.uses === ACTION_PINS.checkout);
    expect(allCheckouts.length).toBeGreaterThan(0);
    expect(allCheckouts.every(step => step.with?.['persist-credentials'] === false)).toBe(true);
    expect(JSON.stringify(workflow.jobs)).not.toContain('github.event.pull_request.head.sha');
  });

  it('pins every external action to the reviewed full commit SHA set', () => {
    const actionUses = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .map(step => step.uses)
      .filter((uses): uses is string => uses !== undefined);
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every(uses => /^[^@]+@[0-9a-f]{40}$/u.test(uses))).toBe(true);
    expect(new Set(actionUses)).toEqual(new Set(Object.values(ACTION_PINS)));
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
    expect(workflow.concurrency).toEqual({
      group: 'auto-tag-${{ github.repository }}',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs.validate?.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.tag?.permissions).toEqual({ contents: 'write' });
    expect(workflow.jobs.publish?.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['candidate-pack']?.needs).toBe('validate');
    expect(workflow.jobs.test?.needs).toEqual(['validate', 'candidate-pack']);
    expect(workflow.jobs.tag?.needs).toEqual(['validate', 'test']);
    expect(workflow.jobs.publish?.needs).toEqual(['validate', 'candidate-pack', 'test', 'tag']);
    expect(workflow.jobs.validate?.outputs).toEqual({
      commit: '${{ steps.package.outputs.commit }}',
      npm_dist_tag: '${{ steps.package.outputs.npm_dist_tag }}',
      package_name: '${{ steps.package.outputs.package_name }}',
      package_version: '${{ steps.package.outputs.package_version }}',
      tag: '${{ steps.package.outputs.tag }}',
    });
    expect(workflow.jobs.tag?.outputs).toEqual({
      commit: '${{ needs.validate.outputs.commit }}',
      npm_dist_tag: '${{ needs.validate.outputs.npm_dist_tag }}',
      package_name: '${{ needs.validate.outputs.package_name }}',
      package_version: '${{ needs.validate.outputs.package_version }}',
      tag: '${{ needs.validate.outputs.tag }}',
    });
    expect(findStep('tag', 'tag').env).toMatchObject({
      EXPECTED_COMMIT: '${{ needs.validate.outputs.commit }}',
      RELEASE_TAG: '${{ needs.validate.outputs.tag }}',
    });
    expect(findStep('publish', 'Publish or verify existing package').env?.NPM_DIST_TAG)
      .toBe('${{ needs.validate.outputs.npm_dist_tag }}');
    expect(workflow.jobs.validate?.if)
      .toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('binds the tag checkout and pre-mutation verification to the validated commit', () => {
    const tagJob = workflow.jobs.tag!;
    const tagCheckout = tagJob.steps.find(step => step.uses === ACTION_PINS.checkout);
    const verify = findStep('tag', 'Verify checkout commit binding');
    const verifyIndex = tagJob.steps.indexOf(verify);
    const mutationIndex = tagJob.steps.indexOf(findStep('tag', 'Create or verify exact merged-commit tag'));

    expect(tagCheckout?.with).toMatchObject({
      ref: '${{ needs.validate.outputs.commit }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(verify.env).toEqual({
      EXPECTED_COMMIT: '${{ needs.validate.outputs.commit }}',
    });
    expect(verifyIndex).toBeGreaterThan(tagJob.steps.indexOf(tagCheckout!));
    expect(verifyIndex).toBeLessThan(mutationIndex);
  });

  it('creates one immutable candidate before separate test and checkout-free publish jobs', () => {
    const packageJob = workflow.jobs['candidate-pack']!;
    const testJob = workflow.jobs.test!;
    const publishJob = workflow.jobs.publish!;
    const packageCheckout = packageJob.steps.find(step => step.uses === ACTION_PINS.checkout);
    const publishCheckout = publishJob.steps.find(step => step.uses === ACTION_PINS.checkout);
    const publish = findStep('publish', 'Publish or verify existing package');
    const packageScripts = packageJob.steps.map(step => step.run ?? '').join('\n');
    const secretSteps = publishJob.steps.filter(step => (
      JSON.stringify(step.env ?? {}).includes('NPM_TOKEN')
    ));

    expect(packageJob.needs).toBe('validate');
    expect(packageJob.outputs).toEqual({
      artifact_digest: '${{ steps.candidate.outputs.artifact-digest }}',
      artifact_id: '${{ steps.candidate.outputs.artifact-id }}',
      filename: '${{ steps.pack.outputs.filename }}',
      integrity: '${{ steps.pack.outputs.integrity }}',
    });
    expect(packageCheckout?.with).toMatchObject({
      ref: '${{ needs.validate.outputs.commit }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(findStep('candidate-pack', 'Verify exact merged checkout binding').env).toEqual({
      EXPECTED_COMMIT: '${{ needs.validate.outputs.commit }}',
    });
    expect(packageScripts).toContain('npm ci');
    expect(packageScripts).not.toContain('npm run build');
    expect(packageScripts).not.toContain('npm test');
    expect(packageScripts).toContain('npm pack');
    expect(packageScripts).toContain('npm audit --audit-level=high');
    expect(JSON.stringify(packageJob)).not.toContain('NPM_TOKEN');
    expect(testJob.steps.some(step => step.uses === ACTION_PINS.uploadArtifact)).toBe(false);
    expect(findStep('test', 'Download exact candidate artifact for testing').with?.['artifact-ids'])
      .toBe('${{ needs.candidate-pack.outputs.artifact_id }}');
    expect(findStep('test', 'Download exact candidate artifact for testing').with?.['merge-multiple'])
      .toBe(true);
    expect(findStep('test', 'Smoke test the exact candidate tarball in isolation').run)
      .toContain('npm install --prefix "$prefix" --ignore-scripts');
    expect(testJob.steps.indexOf(findStep('test', 'Smoke test the exact candidate tarball in isolation')))
      .toBeLessThan(testJob.steps.indexOf(findStep(
        'test', 'Audit, build, and test exact merged source without secrets',
      )));
    expect(publishJob.needs).toEqual(['validate', 'candidate-pack', 'test', 'tag']);
    expect(publishCheckout).toBeUndefined();
    expect(secretSteps).toEqual([publish]);
    expect(findStep('publish', 'Download exact release artifact').with?.['artifact-ids'])
      .toBe('${{ needs.candidate-pack.outputs.artifact_id }}');
    expect(findStep('publish', 'Download exact release artifact').with?.['merge-multiple'])
      .toBe(true);
    expect(publish.run).toMatch(
      /npm publish "\$RUNNER_TEMP\/takt-package\/\$PACKAGE_FILENAME" .*--ignore-scripts/u,
    );
    expect(publish.run).not.toMatch(/npm (?:ci|run|test)/u);
  });

  it.each([
    ['before package manifest', ['package/../escape', 'package/package.json']],
    ['after package manifest', ['package/package.json', 'package/../escape']],
  ])('rejects a traversal entry %s in both candidate verification scripts', (
    _description,
    entries,
  ) => {
    for (const stepName of [
      'Verify exact candidate before executing project code',
      'Verify exact candidate before publication credentials',
    ]) {
      const jobName = stepName.includes('executing') ? 'test' : 'publish';
      const source = findStep(jobName, stepName).run as string;
      const program = /awk '([^']+)'/u.exec(source)?.[1];
      expect(program).toBeDefined();
      let success = true;
      try {
        execFileSync('awk', [program as string], {
          input: `${entries.join('\n')}\n`,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch {
        success = false;
      }
      expect(success, `${jobName} accepted traversal after END processing`).toBe(false);
    }
  });

  it('reverifies the remote tag inside the npm-credential mutation step', () => {
    const publish = findStep('publish', 'Publish or verify existing package');
    expect(publish.env).toMatchObject({
      EXPECTED_COMMIT: '${{ needs.validate.outputs.commit }}',
      GH_TOKEN: '${{ github.token }}',
      RELEASE_TAG: '${{ needs.validate.outputs.tag }}',
    });
    expect(publish.run).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG"');
    expect(publish.run?.indexOf('gh api')).toBeLessThan(publish.run?.indexOf('npm view') ?? -1);
    expect(publish.run).toContain('assert_remote_tag()');
    expect(publish.run?.match(/^\s*assert_remote_tag$/gmu)).toHaveLength(3);
    expect(publish.run).toMatch(/assert_remote_tag\n\s+npm publish/u);
    expect(publish.run).toMatch(/for tag in \$tags; do\n\s+assert_remote_tag\n\s+npm dist-tag add/u);
  });

  it('proves directory lifecycle control while documenting tarball publish limits', () => {
    const directory = createTemporaryDirectory('takt-auto-tag-publish-');
    const source = join(directory, 'source');
    const sentinel = join(directory, 'lifecycle-token');
    mkdirSync(source);
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: 'takt-token-boundary-fixture',
      version: '1.2.3',
      scripts: {
        prepublishOnly: 'node -e "require(\'node:fs\').writeFileSync(process.env.SENTINEL_PATH, process.env.NODE_AUTH_TOKEN || \'missing\')"',
      },
    }));
    const environment = {
      ...process.env,
      NODE_AUTH_TOKEN: 'must-not-reach-lifecycle',
      NPM_CONFIG_DRY_RUN: 'true',
      SENTINEL_PATH: sentinel,
    };

    // npm does not provide the same lifecycle proof for a tarball operand as
    // for a directory operand. This control demonstrates that the sentinel is
    // observable, while the production tarball boundary is enforced by the
    // exact argv mutation test below.
    execFileSync('npm', ['publish', '.', '--dry-run'], {
      cwd: source, env: environment, stdio: 'pipe', timeout: EXEC_TIMEOUT_MS,
    });
    expect(readFileSync(sentinel, 'utf8')).toBe('must-not-reach-lifecycle');
    rmSync(sentinel);
    execFileSync('npm', ['publish', '.', '--dry-run', '--ignore-scripts'], {
      cwd: source, env: environment, stdio: 'pipe', timeout: EXEC_TIMEOUT_MS,
    });
    expect(existsSync(sentinel)).toBe(false);
  });

  it('detects removal of --ignore-scripts from the exact production publish argv', () => {
    const source = findStep('publish', 'Publish or verify existing package').run as string;
    expect(source).toMatch(/npm publish .* --ignore-scripts/u);
    const mutated = source.replace(' --ignore-scripts', '');
    expect(mutated).not.toBe(source);
    expect(mutated).not.toMatch(/npm publish .* --ignore-scripts/u);
  });

  it.each([
    ['published with same integrity', 'same', '1.2.3', 'matching', true, false],
    ['published with different integrity', 'different', '1.2.3', 'matching', false, false],
    ['not published and dist-tags absent', 'missing', '', 'matching', true, true],
    ['newer dist-tag would be downgraded', 'same', '9.0.0', 'matching', false, false],
    ['remote tag deleted before mutation', 'same', '1.2.3', 'deleted', false, false],
    ['remote tag retargeted before mutation', 'same', '1.2.3', 'retargeted', false, false],
    ['remote tag deleted immediately before publish', 'missing', '', 'deleted-after-first', false, false],
    ['remote tag retargeted immediately before dist-tag', 'same', '1.2.3', 'retargeted-after-first', false, false],
  ])('converges npm publication for %s', (
    _description,
    registryMode,
    currentTag,
    remoteTagMode,
    expectedSuccess,
    expectedPublish,
  ) => {
    const directory = createTemporaryDirectory('takt-auto-tag-registry-rerun-');
    const candidateDirectory = join(directory, 'takt-package');
    const bin = join(directory, 'bin');
    const ghLog = join(directory, 'gh.log');
    const log = join(directory, 'npm.log');
    const filename = 'takt-1.2.3.tgz';
    const tarball = Buffer.from('exact candidate bytes');
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    mkdirSync(candidateDirectory);
    mkdirSync(bin);
    writeFileSync(join(candidateDirectory, filename), tarball);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$*" in
  'view takt dist-tags.latest'|'view takt dist-tags.next')
    [ -n "$CURRENT_TAG" ] && printf '%s\\n' "$CURRENT_TAG"
    exit 0
    ;;
  'view takt@1.2.3 name version dist.integrity --json')
    if [ "$REGISTRY_MODE" = missing ]; then echo 'E404 Not Found' >&2; exit 1; fi
    registry_integrity=$EXPECTED_INTEGRITY
    [ "$REGISTRY_MODE" = same ] || registry_integrity='sha512-different'
    printf '{"name":"takt","version":"1.2.3","dist.integrity":"%s"}\\n' "$registry_integrity"
    ;;
  publish*|dist-tag*) exit 0 ;;
  *) exit 99 ;;
esac
`);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
count=0
[ ! -f "$GH_LOG" ] || count=$(cat "$GH_LOG")
count=$((count + 1))
printf '%s\n' "$count" > "$GH_LOG"
case "$REMOTE_TAG_MODE" in
  deleted) exit 1 ;;
  retargeted) printf 'commit\t%s\n' "ffffffffffffffffffffffffffffffffffffffff" ;;
  deleted-after-first)
    [ "$count" -eq 1 ] || exit 1
    printf 'commit\t%s\n' "$EXPECTED_COMMIT"
    ;;
  retargeted-after-first)
    if [ "$count" -eq 1 ]; then
      printf 'commit\t%s\n' "$EXPECTED_COMMIT"
    else
      printf 'commit\t%s\n' "ffffffffffffffffffffffffffffffffffffffff"
    fi
    ;;
  matching) printf 'commit\t%s\n' "$EXPECTED_COMMIT" ;;
  *) exit 99 ;;
esac
`);
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(join(bin, 'gh'), 0o755);
    let success = true;
    try {
      execFileSync('/bin/bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        findStep('publish', 'Publish or verify existing package').run as string,
      ], {
        cwd: directory,
        env: {
          ...process.env,
          CURRENT_TAG: currentTag,
          EXPECTED_COMMIT: HEAD_SHA,
          EXPECTED_INTEGRITY: integrity,
          EXPECTED_VERSION: '1.2.3',
          GH_TOKEN: 'read-only-test-token',
          GITHUB_REPOSITORY: 'example/takt',
          GH_LOG: ghLog,
          NPM_DIST_TAG: 'latest',
          NPM_LOG: log,
          PACKAGE_FILENAME: filename,
          PACKAGE_NAME: 'takt',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REGISTRY_MODE: registryMode,
          RELEASE_TAG: 'v1.2.3',
          REMOTE_TAG_MODE: remoteTagMode,
          RUNNER_TEMP: directory,
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      success = false;
    }
    expect(success).toBe(expectedSuccess);
    const npmLog = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(npmLog.split('\n').some(line => line.startsWith('publish ')))
      .toBe(expectedPublish);
    if (remoteTagMode !== 'matching') {
      expect(npmLog.split('\n').some(line => (
        line.startsWith('publish ') || line.startsWith('dist-tag add ')
      ))).toBe(false);
    }
  });

  it.each([
    ['matching checkout', MERGE_SHA, true],
    ['wrong checkout', 'e'.repeat(40), false],
  ])('executes candidate commit binding and rejects %s', (
    _description,
    checkedOutCommit,
    success,
  ) => {
    const directory = createTemporaryDirectory('takt-auto-tag-tag-binding-');
    const git = join(directory, 'git');
    writeFileSync(git, `#!/bin/sh
case "$*" in
  'rev-parse --verify HEAD^{commit}') printf '%s\\n' "$CHECKED_OUT_COMMIT" ;;
  *) exit 99 ;;
esac
`);
    chmodSync(git, 0o755);
    let actualSuccess = true;
    try {
      execFileSync('/bin/bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        findStep('candidate-pack', 'Verify exact merged checkout binding').run as string,
      ], {
        cwd: directory,
        env: {
          ...process.env,
          CHECKED_OUT_COMMIT: checkedOutCommit,
          EXPECTED_COMMIT: MERGE_SHA,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      actualSuccess = false;
    }
    expect(actualSuccess).toBe(success);
  });

  it.each([
    ['matching validated commit', HEAD_SHA, true],
    ['missing validated commit object', undefined, false],
    ['wrong checked-out commit', 'e'.repeat(40), false],
  ])('executes tag checkout binding and rejects %s', (
    _description,
    checkedOutCommit,
    expectedSuccess,
  ) => {
    const directory = createTemporaryDirectory('takt-auto-tag-checkout-binding-');
    const git = join(directory, 'git');
    writeFileSync(git, `#!/bin/sh
case "$*" in
  'rev-parse --verify HEAD^{commit}')
    [ -n "$CHECKED_OUT_COMMIT" ] || exit 1
    printf '%s\\n' "$CHECKED_OUT_COMMIT"
    ;;
  *) exit 99 ;;
esac
`);
    chmodSync(git, 0o755);
    let actualSuccess = true;
    try {
      execFileSync('/bin/bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        findStep('tag', 'Verify checkout commit binding').run as string,
      ], {
        cwd: directory,
        env: {
          ...process.env,
          CHECKED_OUT_COMMIT: checkedOutCommit ?? '',
          EXPECTED_COMMIT: HEAD_SHA,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      actualSuccess = false;
    }
    expect(actualSuccess).toBe(expectedSuccess);
  });

  it('binds registry verification to the exact package version and expected dist-tag', () => {
    const verify = findStep('publish', 'Verify published package identity');
    expect(verify.env).toMatchObject({
      EXPECTED_DIST_TAG: '${{ needs.tag.outputs.npm_dist_tag }}',
      EXPECTED_INTEGRITY: '${{ needs.candidate-pack.outputs.integrity }}',
      EXPECTED_VERSION: '${{ needs.validate.outputs.package_version }}',
      PACKAGE_NAME: '${{ needs.validate.outputs.package_name }}',
    });
    expect(verify.run).toContain(
      'npm view "${PACKAGE_NAME}@${EXPECTED_VERSION}" version',
    );
    expect(verify.run).toContain(
      'npm view "${PACKAGE_NAME}@${EXPECTED_VERSION}" dist.integrity',
    );
    expect(verify.run).toContain(
      'npm view "$PACKAGE_NAME" "dist-tags.${EXPECTED_DIST_TAG}"',
    );
    expect(verify.run).not.toMatch(/\[ "\$LATEST" = "\$NEXT" \]/u);
    expect(verify.run).not.toContain('::warning::');
    expect(verify.run).toMatch(/exit 1/u);
  });

  it.each([
    ['matching registry identity', '1.2.3', '1.2.3', 'same', true],
    ['mismatched package version', '9.9.9', '1.2.3', 'same', false],
    ['mismatched dist-tag', '1.2.3', '9.9.9', 'same', false],
    ['mismatched integrity', '1.2.3', '1.2.3', 'different', false],
  ])('executes exact registry identity verification: %s', (
    _description,
    publishedVersion,
    taggedVersion,
    integrity,
    expectedSuccess,
  ) => {
    const directory = createTemporaryDirectory('takt-auto-tag-registry-');
    const bin = join(directory, 'bin');
    const log = join(directory, 'npm.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$*" in
  'view takt@1.2.3 version') printf '%s\\n' "$PUBLISHED_VERSION" ;;
  'view takt@1.2.3 dist.integrity') printf '%s\\n' "$PUBLISHED_INTEGRITY" ;;
  'view takt dist-tags.latest') printf '%s\\n' "$TAGGED_VERSION" ;;
  *) exit 99 ;;
esac
`);
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    let success = true;
    try {
      execFileSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
          findStep('publish', 'Verify published package identity').run as string],
        {
          cwd: directory,
          env: {
            ...process.env,
            EXPECTED_DIST_TAG: 'latest',
            EXPECTED_INTEGRITY: 'same',
            EXPECTED_VERSION: '1.2.3',
            NPM_LOG: log,
            PACKAGE_NAME: 'takt',
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            PUBLISHED_VERSION: publishedVersion,
            PUBLISHED_INTEGRITY: integrity,
            TAGGED_VERSION: taggedVersion,
          },
          stdio: 'pipe',
          timeout: EXEC_TIMEOUT_MS,
        },
      );
    } catch {
      success = false;
    }
    expect(success).toBe(expectedSuccess);
    const commands = readFileSync(log, 'utf8').trim().split('\n');
    expect(new Set(commands)).toEqual(new Set([
      'view takt@1.2.3 version',
      'view takt@1.2.3 dist.integrity',
      'view takt dist-tags.latest',
    ]));
  });

  it('uses option-safe, fully qualified tag refspecs in the actual mutation script', () => {
    const script = findStep('tag', 'Create or verify exact merged-commit tag').run;
    expect(script).toBeDefined();
    const directory = createTemporaryDirectory('takt-auto-tag-mutation-');
    const gitPath = join(directory, 'git');
    const ghPath = join(directory, 'gh');
    const logPath = join(directory, 'git.log');
    writeFileSync(gitPath, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\n');
    writeFileSync(ghPath, '#!/bin/sh\n[ "$*" = "auth setup-git" ]\n');
    chmodSync(gitPath, 0o755);
    chmodSync(ghPath, 0o755);
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script as string], {
      env: {
        ...process.env,
        GIT_LOG: logPath,
        GH_TOKEN: 'test-token',
        EXPECTED_COMMIT: HEAD_SHA,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RELEASE_TAG: 'v1.2.3',
      },
      stdio: 'pipe',
      timeout: EXEC_TIMEOUT_MS,
    });
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
      'ls-remote --refs origin refs/tags/v1.2.3',
      `tag -- v1.2.3 ${HEAD_SHA}`,
      'push -- origin refs/tags/v1.2.3:refs/tags/v1.2.3',
    ]);
  });

  it.each([
    ['same existing tag', HEAD_SHA, true, false],
    ['different existing tag', 'f'.repeat(40), false, false],
    ['missing tag', '', true, true],
  ])('converges tag reruns for %s', (_description, existingCommit, success, createsTag) => {
    const script = findStep('tag', 'Create or verify exact merged-commit tag').run;
    expect(script).toBeDefined();
    const directory = createTemporaryDirectory('takt-auto-tag-existing-');
    const gitPath = join(directory, 'git');
    const ghPath = join(directory, 'gh');
    const logPath = join(directory, 'git.log');
    writeFileSync(gitPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$*" in
  'ls-remote --refs origin refs/tags/v1.2.3')
    [ -n "$EXISTING_COMMIT" ] && printf '%s\\trefs/tags/v1.2.3\\n' "$EXISTING_COMMIT"
    exit 0
    ;;
  'fetch --no-tags origin refs/tags/v1.2.3') ;;
  'rev-parse --verify FETCH_HEAD^{commit}') printf '%s\\n' "$EXISTING_COMMIT" ;;
esac
`);
    writeFileSync(ghPath, '#!/bin/sh\n[ "$*" = "auth setup-git" ]\n');
    chmodSync(gitPath, 0o755);
    chmodSync(ghPath, 0o755);
    let actualSuccess = true;
    try {
      execFileSync('/bin/bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script as string,
      ], {
        env: {
          ...process.env,
          EXISTING_COMMIT: existingCommit,
          EXPECTED_COMMIT: HEAD_SHA,
          GIT_LOG: logPath,
          GH_TOKEN: 'test-token',
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          RELEASE_TAG: 'v1.2.3',
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      actualSuccess = false;
    }
    expect(actualSuccess).toBe(success);
    const log = readFileSync(logPath, 'utf8');
    expect(log.includes(`tag -- v1.2.3 ${HEAD_SHA}`)).toBe(createsTag);
  });
});
