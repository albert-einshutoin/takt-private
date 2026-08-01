import { execFileSync } from 'node:child_process';
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
    HEAD_SHA,
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
      commit: HEAD_SHA,
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
    ['head commit', { environment: { HEAD_SHA: 'deadbeef' } }],
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

  it('checks out only package.json from the exact head without credentials', () => {
    const checkout = findStep('validate', 'Read package metadata from PR head');
    expect(checkout.uses).toBe(ACTION_PINS.checkout);
    expect(checkout.with).toMatchObject({
      'persist-credentials': false,
      ref: '${{ github.event.pull_request.head.sha }}',
      'sparse-checkout': 'package.json',
      'sparse-checkout-cone-mode': false,
    });
    const allCheckouts = Object.values(workflow.jobs)
      .flatMap(job => job.steps)
      .filter(step => step.uses === ACTION_PINS.checkout);
    expect(allCheckouts.length).toBeGreaterThan(0);
    expect(allCheckouts.every(step => step.with?.['persist-credentials'] === false)).toBe(true);
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
    expect(workflow.jobs.validate?.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.tag?.permissions).toEqual({ contents: 'write' });
    expect(workflow.jobs.publish?.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.tag?.needs).toBe('validate');
    expect(workflow.jobs.publish?.needs).toEqual(['tag', 'package']);
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
      HEAD_SHA: '${{ needs.validate.outputs.commit }}',
      RELEASE_TAG: '${{ needs.validate.outputs.tag }}',
    });
    expect(findStep('publish', 'Publish verified package').env?.NPM_DIST_TAG)
      .toBe('${{ needs.tag.outputs.npm_dist_tag }}');
    expect(findStep('publish', 'Sync next tag on stable release')).toMatchObject({
      if: "needs.tag.outputs.npm_dist_tag == 'latest'",
      env: {
        NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
        PACKAGE_NAME: '${{ needs.tag.outputs.package_name }}',
        RELEASE_VERSION: '${{ needs.tag.outputs.package_version }}',
      },
    });
    expect(workflow.jobs.validate?.if)
      .toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('builds and packs without secrets before a checkout-free publish job', () => {
    const packageJob = workflow.jobs.package!;
    const publishJob = workflow.jobs.publish!;
    const packageCheckout = packageJob.steps.find(step => step.uses === ACTION_PINS.checkout);
    const publishCheckout = publishJob.steps.find(step => step.uses === ACTION_PINS.checkout);
    const publish = findStep('publish', 'Publish verified package');
    const packageScripts = packageJob.steps.map(step => step.run ?? '').join('\n');
    const secretSteps = publishJob.steps.filter(step => (
      JSON.stringify(step.env ?? {}).includes('NPM_TOKEN')
    ));

    expect(packageJob.needs).toBe('tag');
    expect(packageJob.outputs).toEqual({ filename: '${{ steps.pack.outputs.filename }}' });
    expect(packageCheckout?.with).toMatchObject({
      ref: '${{ needs.tag.outputs.commit }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(findStep('package', 'Verify checkout and tag commit binding').env).toEqual({
      EXPECTED_COMMIT: '${{ needs.tag.outputs.commit }}',
      RELEASE_TAG: '${{ needs.tag.outputs.tag }}',
    });
    expect(packageScripts).toContain('npm ci');
    expect(packageScripts).toContain('npm run build');
    expect(packageScripts).toContain('npm test');
    expect(packageScripts).toContain('npm pack');
    expect(JSON.stringify(packageJob)).not.toContain('NPM_TOKEN');
    expect(publishJob.needs).toEqual(['tag', 'package']);
    expect(publishCheckout).toBeUndefined();
    expect(secretSteps).toEqual([publish, findStep('publish', 'Sync next tag on stable release')]);
    expect(publish.run).toMatch(
      /npm publish "\$RUNNER_TEMP\/takt-package\/\$PACKAGE_FILENAME" .*--ignore-scripts/u,
    );
    expect(publish.run).not.toMatch(/npm (?:ci|run|test)/u);
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
    const source = findStep('publish', 'Publish verified package').run as string;
    const execute = (script: string): string => {
      const directory = createTemporaryDirectory('takt-auto-tag-publish-argv-');
      const bin = join(directory, 'bin');
      const log = join(directory, 'npm.log');
      mkdirSync(bin);
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$NPM_LOG"\n');
      chmodSync(join(bin, 'npm'), 0o755);
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        cwd: directory,
        env: {
          ...process.env,
          NPM_DIST_TAG: 'latest',
          NPM_LOG: log,
          PACKAGE_FILENAME: 'takt-1.2.3.tgz',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: directory,
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      });
      return readFileSync(log, 'utf8').trim();
    };
    const assertSafePublishArgv = (argv: string): void => {
      expect(argv.split(' ')).toContain('--ignore-scripts');
    };

    assertSafePublishArgv(execute(source));
    const mutated = source.replace(' --ignore-scripts', '');
    expect(mutated).not.toBe(source);
    expect(() => assertSafePublishArgv(execute(mutated))).toThrow();
  });

  it.each([
    ['matching checkout and tag', HEAD_SHA, HEAD_SHA, true],
    ['wrong checkout', 'e'.repeat(40), HEAD_SHA, false],
    ['retargeted tag', HEAD_SHA, 'f'.repeat(40), false],
  ])('executes package commit binding and rejects %s', (
    _description,
    checkedOutCommit,
    taggedCommit,
    success,
  ) => {
    const directory = createTemporaryDirectory('takt-auto-tag-tag-binding-');
    const git = join(directory, 'git');
    writeFileSync(git, `#!/bin/sh
case "$*" in
  'rev-parse --verify HEAD^{commit}') printf '%s\\n' "$CHECKED_OUT_COMMIT" ;;
  'rev-parse --verify refs/tags/v1.2.3^{commit}') printf '%s\\n' "$TAGGED_COMMIT" ;;
  *) exit 99 ;;
esac
`);
    chmodSync(git, 0o755);
    let actualSuccess = true;
    try {
      execFileSync('/bin/bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        findStep('package', 'Verify checkout and tag commit binding').run as string,
      ], {
        cwd: directory,
        env: {
          ...process.env,
          CHECKED_OUT_COMMIT: checkedOutCommit,
          EXPECTED_COMMIT: HEAD_SHA,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          RELEASE_TAG: 'v1.2.3',
          TAGGED_COMMIT: taggedCommit,
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      actualSuccess = false;
    }
    expect(actualSuccess).toBe(success);
  });

  it('binds registry verification to the exact package version and expected dist-tag', () => {
    const verify = findStep('publish', 'Verify published package identity');
    expect(verify.env).toMatchObject({
      EXPECTED_DIST_TAG: '${{ needs.tag.outputs.npm_dist_tag }}',
      EXPECTED_VERSION: '${{ needs.tag.outputs.package_version }}',
      PACKAGE_NAME: '${{ needs.tag.outputs.package_name }}',
    });
    expect(verify.run).toContain(
      'npm view "${PACKAGE_NAME}@${EXPECTED_VERSION}" version',
    );
    expect(verify.run).toContain(
      'npm view "$PACKAGE_NAME" "dist-tags.${EXPECTED_DIST_TAG}"',
    );
    expect(verify.run).not.toMatch(/\[ "\$LATEST" = "\$NEXT" \]/u);
    expect(verify.run).not.toContain('::warning::');
    expect(verify.run).toMatch(/exit 1/u);
  });

  it.each([
    ['matching registry identity', '1.2.3', '1.2.3', true],
    ['mismatched package version', '9.9.9', '1.2.3', false],
    ['mismatched dist-tag', '1.2.3', '9.9.9', false],
  ])('executes exact registry identity verification: %s', (
    _description,
    publishedVersion,
    taggedVersion,
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
            EXPECTED_VERSION: '1.2.3',
            NPM_LOG: log,
            PACKAGE_NAME: 'takt',
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            PUBLISHED_VERSION: publishedVersion,
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
      'view takt dist-tags.latest',
    ]));
  });

  it('uses option-safe, fully qualified tag refspecs in the actual mutation script', () => {
    const script = findStep('tag', 'Create and push tag on PR head commit').run;
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
        HEAD_SHA,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RELEASE_TAG: 'v1.2.3',
      },
      stdio: 'pipe',
      timeout: EXEC_TIMEOUT_MS,
    });
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
      `tag -- v1.2.3 ${HEAD_SHA}`,
      'push -- origin refs/tags/v1.2.3:refs/tags/v1.2.3',
    ]);
  });

  it('does not push or publish when creating the tag fails because it already exists', () => {
    const script = findStep('tag', 'Create and push tag on PR head commit').run;
    expect(script).toBeDefined();
    const directory = createTemporaryDirectory('takt-auto-tag-existing-');
    const gitPath = join(directory, 'git');
    const ghPath = join(directory, 'gh');
    const logPath = join(directory, 'git.log');
    writeFileSync(gitPath, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\n[ "$1" != tag ]\n');
    writeFileSync(ghPath, '#!/bin/sh\n[ "$*" = "auth setup-git" ]\n');
    chmodSync(gitPath, 0o755);
    chmodSync(ghPath, 0o755);
    expect(() => execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script as string],
      {
        env: {
          ...process.env,
          GIT_LOG: logPath,
          GH_TOKEN: 'test-token',
          HEAD_SHA,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          RELEASE_TAG: 'v1.2.3',
        },
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT_MS,
      },
    )).toThrow();
    expect(readFileSync(logPath, 'utf8').trim()).toBe(`tag -- v1.2.3 ${HEAD_SHA}`);
  });
});
