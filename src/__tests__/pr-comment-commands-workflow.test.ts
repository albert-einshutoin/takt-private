import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const workflowPath = resolve('.github/workflows/pr-comment-commands.yml');
const reviewWorkflowPath = resolve('builtins/en/workflows/review-takt-default.yaml');
const claudeToolchainManifestPath = resolve('.github/toolchains/claude-code/package.json');
const claudeToolchainLockPath = resolve('.github/toolchains/claude-code/package-lock.json');
const ACTION_PINS = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  downloadArtifact: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  githubScript: 'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  takt: 'nrslib/takt-action@e5b9b2d7b98c6eb0909670621ac6dfe1b8f20322',
  slack: 'slackapi/slack-github-action@485a9d42d3a73031f12ec201c457e2162c45d02d',
} as const;
const requireForHarness = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface ReviewEventFixture {
  readonly body: string;
  readonly isPullRequest: boolean;
  readonly authorAssociation: string;
}

interface WorkflowStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, string | boolean | number>>;
  readonly ['working-directory']?: string;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly environment?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowStep[];
}

interface WorkflowContract {
  readonly on?: { readonly issue_comment?: { readonly types?: readonly string[] } };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

function readWorkflow(source = readFileSync(workflowPath, 'utf8')): WorkflowContract {
  return parseYaml(source) as WorkflowContract;
}

function findStep(job: WorkflowJob, idOrName: string): WorkflowStep {
  const step = job.steps.find(candidate => (
    candidate.id === idOrName || candidate.name === idOrName
  ));
  expect(step, `missing workflow step: ${idOrName}`).toBeDefined();
  return step as WorkflowStep;
}

function executeResolvePushFixture(options: {
  readonly branch?: string;
  readonly defaultBranch?: string;
  readonly remoteHead: string;
  readonly leaseReject?: boolean;
  readonly merged?: boolean;
  readonly state?: 'open' | 'closed';
}): { readonly status: number; readonly gitLog: string; readonly output: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'takt-resolve-push-'));
  temporaryDirectories.push(root);
  const bin = resolve(root, 'bin');
  mkdirSync(bin);
  const gitLog = resolve(root, 'git.log');
  const pushed = resolve(root, 'pushed');
  const output = resolve(root, 'github-output');
  const headSha = '0123456789abcdef0123456789abcdef01234567';
  const baseSha = '123456789abcdef0123456789abcdef012345678';
  const candidateSha = '23456789abcdef0123456789abcdef0123456789';
  const branch = options.branch ?? 'fix/conflicts';
  const defaultBranch = options.defaultBranch ?? 'main';
  const gitScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'printf "%s\\n" "$*" >> "$MOCK_GIT_LOG"',
    'case " $* " in',
    '  *" check-ref-format --branch "*) exit 0 ;;',
    '  *" ls-remote origin "*)',
    '    if [ -f "$MOCK_PUSHED" ]; then printf "%s\\trefs/heads/%s\\n" "$MOCK_CANDIDATE_SHA" "$BRANCH";',
    '    elif [ -n "$MOCK_REMOTE_HEAD" ]; then printf "%s\\trefs/heads/%s\\n" "$MOCK_REMOTE_HEAD" "$BRANCH"; fi',
    '    exit 0 ;;',
    '  *" push "*)',
    '    [[ "$*" == *"--force-with-lease=refs/heads/$BRANCH:$HEAD_SHA"* ]] || exit 90',
    '    [ "$MOCK_LEASE_REJECT" != 1 ] || exit 1',
    '    : > "$MOCK_PUSHED"',
    '    exit 0 ;;',
    '  *" rev-parse HEAD "*) printf "%s\\n" "$MOCK_CANDIDATE_SHA"; exit 0 ;;',
    'esac',
    'exit 91',
  ].join('\n');
  const ghScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "$*" == *"/pulls/"* ]]; then printf "%s\\n" "$MOCK_PR_JSON";',
    'else printf "%s\\n" "$MOCK_REPO_JSON"; fi',
  ].join('\n');
  for (const [name, source] of [['git', gitScript], ['gh', ghScript]] as const) {
    const path = resolve(bin, name);
    writeFileSync(path, `${source}\n`);
    chmodSync(path, 0o755);
  }
  const push = findStep(readWorkflow().jobs['resolve-publish']!, 'Push exact candidate commit with lease');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', push.run!], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BASE_SHA: baseSha,
      BRANCH: branch,
      DEFAULT_BRANCH: defaultBranch,
      GH_TOKEN: 'test-token',
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'owner/repo',
      HEAD_SHA: headSha,
      MOCK_CANDIDATE_SHA: candidateSha,
      MOCK_GIT_LOG: gitLog,
      MOCK_LEASE_REJECT: options.leaseReject ? '1' : '0',
      MOCK_PR_JSON: JSON.stringify({
        state: options.state ?? 'open', merged: options.merged ?? false,
        head: { ref: branch, sha: headSha, repo: { full_name: 'owner/repo' } },
        base: { sha: baseSha, repo: { full_name: 'owner/repo' } },
      }),
      MOCK_PUSHED: pushed,
      MOCK_REMOTE_HEAD: options.remoteHead,
      MOCK_REPO_JSON: JSON.stringify({ default_branch: defaultBranch }),
      PR_NUMBER: '164',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    gitLog: readFileSync(gitLog, 'utf8'),
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
  };
}

function executeResolvePrepareIdentityFixture(options: {
  readonly branch?: string;
  readonly merged?: boolean;
  readonly state?: 'open' | 'closed';
}): { readonly status: number; readonly output: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'takt-resolve-prepare-'));
  temporaryDirectories.push(root);
  const bin = resolve(root, 'bin');
  mkdirSync(bin);
  const output = resolve(root, 'github-output');
  const branch = options.branch ?? 'fix/conflicts';
  const prJson = JSON.stringify({
    state: options.state ?? 'open',
    merged: options.merged ?? false,
    head: {
      ref: branch,
      sha: '0123456789abcdef0123456789abcdef01234567',
      repo: { full_name: 'owner/repo' },
    },
    base: {
      sha: '123456789abcdef0123456789abcdef012345678',
      repo: { full_name: 'owner/repo' },
    },
  });
  const scripts = {
    gh: [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$*" == *"/pulls/"* ]]; then printf "%s\\n" "$MOCK_PR_JSON";',
      'else printf "%s\\n" "$MOCK_REPO_JSON"; fi',
    ].join('\n'),
    git: '#!/usr/bin/env bash\n[ "$1" = check-ref-format ]\n',
  };
  for (const [name, source] of Object.entries(scripts)) {
    const path = resolve(bin, name);
    writeFileSync(path, `${source}\n`);
    chmodSync(path, 0o755);
  }
  const prepare = readWorkflow().jobs['resolve-prepare']!;
  const identity = findStep(prepare, 'Capture exact same-repository PR identity');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', identity.run!], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_TOKEN: 'test-token',
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'owner/repo',
      MOCK_PR_JSON: prJson,
      MOCK_REPO_JSON: JSON.stringify({ default_branch: 'main' }),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PR_NUMBER: '164',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
  };
}

function assertResolveExecutionBoundary(workflow: WorkflowContract): void {
  const apply = workflow.jobs['resolve-apply']!;
  const test = workflow.jobs['resolve-test']!;
  const publish = workflow.jobs['resolve-publish']!;

  expect(apply.permissions).toEqual({ contents: 'read' });
  expect(test.permissions).toEqual({ contents: 'read' });
  expect(publish.permissions).toEqual({ contents: 'write' });
  expect(JSON.stringify(apply)).not.toMatch(/secrets\.|ANTHROPIC|npm test|npm run build/iu);
  expect(JSON.stringify(test)).not.toMatch(/secrets\.|ANTHROPIC|upload-artifact/iu);
  expect(test.outputs).toBeUndefined();
  expect(publish.needs).toEqual([
    'resolve-prepare', 'resolve-propose', 'resolve-apply', 'resolve-test',
  ]);
  expect(findStep(publish, 'Download exact candidate artifact').with?.['artifact-ids'])
    .toBe('${{ needs.resolve-apply.outputs.artifact_id }}');
}

function assertTrustedClaudeInstall(
  job: WorkflowJob,
  providerStepName: string,
  manifestRoot = '$GITHUB_WORKSPACE',
): void {
  const install = findStep(job, 'Install trusted Claude Code');
  const installIndex = job.steps.indexOf(install);
  const providerIndex = job.steps.findIndex(step => step.name === providerStepName);

  expect(providerIndex).toBeGreaterThan(-1);
  expect(installIndex).toBeLessThan(providerIndex);
  expect(install.env).toEqual({
    CLAUDE_TOOLCHAIN_DIR: '${{ runner.temp }}/claude-code-toolchain',
  });
  expect(JSON.stringify(install)).not.toMatch(/ANTHROPIC_API_KEY|secrets\./u);
  expect(install.run).toContain(
    `cp -- "${manifestRoot}/.github/toolchains/claude-code/package.json" "$CLAUDE_TOOLCHAIN_DIR/package.json"`,
  );
  expect(install.run).toContain(
    `cp -- "${manifestRoot}/.github/toolchains/claude-code/package-lock.json" "$CLAUDE_TOOLCHAIN_DIR/package-lock.json"`,
  );
  expect(install.run).toContain(
    'npm ci --prefix "$CLAUDE_TOOLCHAIN_DIR" --ignore-scripts --no-audit --no-fund',
  );
  expect(install.run).toContain(
    'npm audit --prefix "$CLAUDE_TOOLCHAIN_DIR" --audit-level=high --omit=dev',
  );
  expect(install.run).toContain(
    'claude_bin="$CLAUDE_TOOLCHAIN_DIR/node_modules/@anthropic-ai/claude-code-linux-x64/claude"',
  );
  expect(install.run).toContain('test -x "$claude_bin"');
  expect(install.run).toContain(
    '"$claude_bin" --version | grep -Eq \'^2\\.1\\.220([[:space:]]|$)\'',
  );
  expect(install.run).not.toMatch(/npm install|--global|@(?:latest|next|beta)\b/u);
}

function compileCommandCondition(
  condition: string,
  expectedCommand: string,
  expectedAssociations: readonly string[],
): (event: ReviewEventFixture) => boolean {
  const normalized = condition.replace(/\s+/gu, ' ').trim();
  const semanticShape = normalized.match(
    /^github\.event\.issue\.pull_request != null && \( github\.event\.comment\.body == '(\/[a-z]+)' \|\| startsWith\(github\.event\.comment\.body, '\1 '\) \|\| startsWith\(github\.event\.comment\.body, format\('\1\{0\}', fromJSON\('"\\n"'\)\)\) \) && contains\(fromJSON\('(\[[^']+\])'\), github\.event\.comment\.author_association\)$/u,
  );
  if (semanticShape === null) {
    throw new Error('command condition is outside the closed security grammar');
  }

  const command = semanticShape[1]!;
  if (command !== expectedCommand) {
    throw new Error('command condition changed the command name');
  }
  const allowedAssociations = JSON.parse(semanticShape[2]!) as unknown;
  if (!Array.isArray(allowedAssociations)
    || allowedAssociations.some(value => typeof value !== 'string')
    || JSON.stringify(allowedAssociations) !== JSON.stringify(expectedAssociations)) {
    throw new Error('command condition changed the trusted association set');
  }

  return (event) => event.isPullRequest
    && (
      event.body === command
      || event.body.startsWith(`${command} `)
      || event.body.startsWith(`${command}\n`)
    )
    && allowedAssociations.includes(event.authorAssociation);
}

function compileReviewCondition(condition: string): (event: ReviewEventFixture) => boolean {
  return compileCommandCondition(
    condition,
    '/review',
    ['OWNER', 'MEMBER', 'COLLABORATOR'],
  );
}

const REVIEWED_HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

function manifestWithReportDigest(
  reportDigest: string,
  head = REVIEWED_HEAD_SHA,
): string {
  const headDigest = createHash('sha256').update(`${head}\n`).digest('hex');
  return `${reportDigest}  review-summary.md\n${headDigest}  reviewed-head.sha\nreviewed-head=${head}\n`;
}

interface PublisherFixture {
  readonly artifactHead?: string;
  readonly currentHead?: string;
  readonly extraPath?: boolean;
  readonly manifest?: string;
  readonly missing?: 'head' | 'manifest' | 'report';
  readonly report?: Buffer;
  readonly symlinkReport?: boolean;
}

async function runPublisher(
  fixture: PublisherFixture = {},
  source = findStep(readWorkflow().jobs['publish-review']!, 'Validate and publish review report')
    .with!.script as string,
): Promise<{
  readonly comments: string[];
  readonly failures: string[];
  readonly reviewCommits: string[];
}> {
  const root = mkdtempSync(resolve(tmpdir(), 'takt-review-publisher-'));
  temporaryDirectories.push(root);
  const report = fixture.report ?? Buffer.from('verified review', 'utf8');
  const artifactHead = fixture.artifactHead ?? REVIEWED_HEAD_SHA;
  const headBytes = Buffer.from(`${artifactHead}\n`, 'utf8');
  const reportPath = resolve(root, 'review-summary.md');
  const manifestPath = resolve(root, 'review-summary.sha256');
  const headPath = resolve(root, 'reviewed-head.sha');

  if (fixture.missing !== 'report') {
    if (fixture.symlinkReport === true) {
      const target = resolve(root, 'symlink-target');
      writeFileSync(target, report);
      symlinkSync(target, reportPath);
    } else {
      writeFileSync(reportPath, report);
    }
  }
  if (fixture.missing !== 'manifest') {
    const reportDigest = createHash('sha256').update(report).digest('hex');
    const headDigest = createHash('sha256').update(headBytes).digest('hex');
    writeFileSync(
      manifestPath,
      fixture.manifest ?? `${reportDigest}  review-summary.md\n${headDigest}  reviewed-head.sha\nreviewed-head=${artifactHead}\n`,
    );
  }
  if (fixture.missing !== 'head') {
    writeFileSync(headPath, headBytes);
  }
  if (fixture.extraPath === true) {
    mkdirSync(resolve(root, 'extra'));
  }

  const comments: string[] = [];
  const reviewCommits: string[] = [];
  const failures: string[] = [];
  let currentHeadChecked = false;
  const github = {
    rest: {
      pulls: {
        get: async () => {
          currentHeadChecked = true;
          return { data: { head: { sha: fixture.currentHead ?? REVIEWED_HEAD_SHA } } };
        },
        createReview: async ({
          body,
          commit_id: commitId,
        }: { body: string; commit_id: string }) => {
          if (!currentHeadChecked) {
            throw new Error('publisher posted before current-head validation');
          }
          comments.push(body);
          reviewCommits.push(commitId);
        },
      },
    },
  };
  const core = { setFailed: (message: string) => failures.push(message) };
  const context = { issue: { number: 164 }, repo: { owner: 'owner', repo: 'repo' } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;

  try {
    await new AsyncFunction('github', 'context', 'core', 'process', 'require', source)(
      github,
      context,
      core,
      { env: { EXPECTED_HEAD_SHA: REVIEWED_HEAD_SHA, REPORT_ROOT: root } },
      requireForHarness,
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return { comments, failures, reviewCommits };
}

function runTaskBuilder(
  metadata: Buffer,
  diff: Buffer,
): { readonly success: boolean; readonly taskExists: boolean; readonly task?: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'takt-review-task-builder-'));
  temporaryDirectories.push(directory);
  const metadataPath = resolve(directory, 'metadata.json');
  const diffPath = resolve(directory, 'diff.patch');
  const taskPath = resolve(directory, 'task.txt');
  writeFileSync(metadataPath, metadata);
  writeFileSync(diffPath, diff);

  const collect = findStep(
    readWorkflow().jobs.review!,
    'Collect immutable PR data without provider secrets',
  );
  const builder = collect.run!.match(
    /node - "\$metadata" "\$diff" "\$task" <<'NODE'\n([\s\S]*?)\nNODE/u,
  );
  expect(builder, 'missing embedded trusted task builder').not.toBeNull();
  let success = true;
  try {
    execFileSync('node', ['-', metadataPath, diffPath, taskPath], {
      input: builder![1],
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_000,
    });
  } catch {
    success = false;
  }
  const taskExists = existsSync(taskPath);
  return {
    success,
    taskExists,
    ...(taskExists ? { task: readFileSync(taskPath, 'utf8') } : {}),
  };
}

describe('PR Comment Commands workflow contract', () => {
  it.each([
    ['/review', true],
    ['/review args', true],
    ['/review\nbody', true],
    ['/reviewer', false],
    ['/review-other', false],
    ['/review\tbody', false],
    [' /review', false],
  ] as const)('matches review command body %j: %s', (body, expected) => {
    const workflow = readWorkflow();
    const matches = compileReviewCondition(workflow.jobs.review!.if!);

    expect(matches({
      body,
      isPullRequest: true,
      authorAssociation: 'OWNER',
    })).toBe(expected);
  });

  it('keeps review restricted to PR comments from the exact trusted associations', () => {
    const workflow = readWorkflow();
    const matches = compileReviewCondition(workflow.jobs.review!.if!);

    expect(workflow.on?.issue_comment?.types).toEqual(['created']);
    expect(matches({
      body: '/review', isPullRequest: false, authorAssociation: 'OWNER',
    })).toBe(false);
    expect(matches({
      body: '/review', isPullRequest: true, authorAssociation: 'CONTRIBUTOR',
    })).toBe(false);
    expect(['OWNER', 'MEMBER', 'COLLABORATOR'].every((authorAssociation) => (
      matches({ body: '/review', isPullRequest: true, authorAssociation })
    ))).toBe(true);
  });

  it.each([
    ['/resolve', true],
    ['/resolve args', true],
    ['/resolve\nbody', true],
    ['/resolver', false],
    ['/resolve-other', false],
    ['/resolve\tbody', false],
    [' /resolve', false],
  ] as const)('matches resolve command body %j: %s', (body, expected) => {
    const prepare = readWorkflow().jobs['resolve-prepare']!;
    const matches = compileCommandCondition(prepare.if!, '/resolve', ['OWNER']);

    expect(matches({ body, isPullRequest: true, authorAssociation: 'OWNER' })).toBe(expected);
  });

  it('restricts resolve to an exact PR command from OWNER', () => {
    const condition = readWorkflow().jobs['resolve-prepare']!.if!;
    const matches = compileCommandCondition(condition, '/resolve', ['OWNER']);

    expect(matches({
      body: '/resolve', isPullRequest: false, authorAssociation: 'OWNER',
    })).toBe(false);
    expect(matches({
      body: '/resolve', isPullRequest: true, authorAssociation: 'MEMBER',
    })).toBe(false);
    expect(() => compileCommandCondition(
      condition.replace('["OWNER"]', '["OWNER", "MEMBER"]'),
      '/resolve',
      ['OWNER'],
    )).toThrow(/trusted association set/u);
  });

  it('keeps resolve behind five explicit least-privilege job boundaries', () => {
    const jobs = readWorkflow().jobs;
    const prepare = jobs['resolve-prepare']!;
    const propose = jobs['resolve-propose']!;
    const apply = jobs['resolve-apply']!;
    const test = jobs['resolve-test']!;
    const publish = jobs['resolve-publish']!;

    expect(Object.keys(jobs).filter(name => name.startsWith('resolve'))).toEqual([
      'resolve-prepare',
      'resolve-propose',
      'resolve-apply',
      'resolve-test',
      'resolve-publish',
    ]);
    expect(jobs.resolve).toBeUndefined();

    expect(prepare.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(propose.permissions).toEqual({});
    expect(apply.permissions).toEqual({ contents: 'read' });
    expect(test.permissions).toEqual({ contents: 'read' });
    expect(publish.permissions).toEqual({ contents: 'write' });
    expect(propose.needs).toBe('resolve-prepare');
    expect(apply.needs).toEqual(['resolve-prepare', 'resolve-propose']);
    expect(test.needs).toEqual(['resolve-prepare', 'resolve-propose', 'resolve-apply']);
    expect(publish.needs).toEqual([
      'resolve-prepare', 'resolve-propose', 'resolve-apply', 'resolve-test',
    ]);

    expect(JSON.stringify(prepare)).not.toMatch(/secrets\.|ANTHROPIC|Acknowledge/iu);
    expect(JSON.stringify(apply)).not.toMatch(/secrets\.|ANTHROPIC|npm test|npm run/iu);
    expect(JSON.stringify(test)).not.toMatch(/secrets\.|ANTHROPIC|upload-artifact/iu);
    expect(test.outputs).toBeUndefined();
    expect(JSON.stringify(publish)).not.toMatch(/ANTHROPIC|claude-code|npm ci/iu);
    expect(JSON.stringify(propose)).toContain('secrets.ANTHROPIC_API_KEY');
    expect(propose.steps.some(step => step.uses === ACTION_PINS.checkout)).toBe(false);
    assertResolveExecutionBoundary(readWorkflow());

    for (const job of [prepare, apply, test, publish]) {
      for (const checkout of job.steps.filter(step => step.uses === ACTION_PINS.checkout)) {
        expect(checkout.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  it('binds every resolve artifact to exact immutable IDs, digests, head, and base', () => {
    const jobs = readWorkflow().jobs;
    const prepare = jobs['resolve-prepare']!;
    const propose = jobs['resolve-propose']!;
    const apply = jobs['resolve-apply']!;
    const test = jobs['resolve-test']!;
    const publish = jobs['resolve-publish']!;

    expect(prepare.outputs).toEqual({
      artifact_id: '${{ steps.bundle.outputs.artifact-id }}',
      artifact_digest: '${{ steps.bundle.outputs.artifact-digest }}',
      base_sha: '${{ steps.pr.outputs.base_sha }}',
      branch: '${{ steps.pr.outputs.branch }}',
      default_branch: '${{ steps.pr.outputs.default_branch }}',
      head_sha: '${{ steps.pr.outputs.head_sha }}',
    });
    expect(propose.outputs).toEqual({
      artifact_id: '${{ steps.proposal.outputs.artifact-id }}',
      artifact_digest: '${{ steps.proposal.outputs.artifact-digest }}',
    });
    expect(apply.outputs).toEqual({
      artifact_id: '${{ steps.candidate.outputs.artifact-id }}',
      artifact_digest: '${{ steps.candidate.outputs.artifact-digest }}',
    });

    expect(findStep(propose, 'Download exact prepare artifact').with).toMatchObject({
      'artifact-ids': '${{ needs.resolve-prepare.outputs.artifact_id }}',
    });
    expect(findStep(apply, 'Download exact prepare artifact').with).toMatchObject({
      'artifact-ids': '${{ needs.resolve-prepare.outputs.artifact_id }}',
    });
    expect(findStep(apply, 'Download exact proposal artifact').with).toMatchObject({
      'artifact-ids': '${{ needs.resolve-propose.outputs.artifact_id }}',
    });
    expect(findStep(test, 'Download exact candidate artifact').with).toMatchObject({
      'artifact-ids': '${{ needs.resolve-apply.outputs.artifact_id }}',
    });
    expect(findStep(publish, 'Download exact candidate artifact').with).toMatchObject({
      'artifact-ids': '${{ needs.resolve-apply.outputs.artifact_id }}',
    });

    for (const job of [propose, apply, test, publish]) {
      const source = JSON.stringify(job);
      expect(source).toContain('needs.resolve-prepare.outputs.head_sha');
      expect(source).toContain('needs.resolve-prepare.outputs.base_sha');
      expect(source).toContain('artifact_digest');
    }
  });

  it('prepares conflicts from exact same-repository head and base without write credentials', () => {
    const prepare = readWorkflow().jobs['resolve-prepare']!;
    const identity = findStep(prepare, 'Capture exact same-repository PR identity');
    const merge = findStep(prepare, 'Merge exact base and prepare immutable conflict input');
    const checkouts = prepare.steps.filter(step => step.uses === ACTION_PINS.checkout);

    expect(identity.run).toContain("head_repo=$(jq -r '.head.repo.full_name'");
    expect(identity.run).toContain("base_repo=$(jq -r '.base.repo.full_name'");
    expect(identity.run).toContain("head_sha=$(jq -r '.head.sha'");
    expect(identity.run).toContain("base_sha=$(jq -r '.base.sha'");
    expect(identity.run).toContain("state=$(jq -r '.state'");
    expect(identity.run).toContain("merged=$(jq -r '.merged'");
    expect(identity.run).toContain('repos/$GITHUB_REPOSITORY');
    expect(identity.run).toContain("default_branch=$(jq -r '.default_branch'");
    expect(identity.run).toContain('[ "$state" != open ]');
    expect(identity.run).toContain('[ "$merged" != false ]');
    expect(identity.run).toContain('[ "$branch" = "$default_branch" ]');
    expect(identity.run).toContain('git check-ref-format --branch "$branch"');
    expect(checkouts.map(step => step.with?.ref)).toEqual([
      '${{ github.sha }}',
      '${{ steps.pr.outputs.head_sha }}',
    ]);
    expect(merge.run).toContain('git fetch --no-tags origin "$BASE_SHA"');
    expect(merge.run).toContain('git config merge.conflictStyle diff3');
    expect(merge.run).toContain('test -n "$(git diff --name-only --diff-filter=U)"');
    expect(merge.run).toContain('resolve-conflicts-contract.mjs" \\');
    expect(merge.run).toMatch(/\n\s+prepare /u);
  });

  it('executes prepare identity only for an open unmerged non-default PR head', () => {
    const accepted = executeResolvePrepareIdentityFixture({});
    expect(accepted.status).toBe(0);
    expect(accepted.output).toContain('branch=fix/conflicts');
    expect(accepted.output).toContain('default_branch=main');

    for (const fixture of [
      { state: 'closed' as const },
      { merged: true },
      { branch: 'main' },
    ]) {
      const rejected = executeResolvePrepareIdentityFixture(fixture);
      expect(rejected.status).not.toBe(0);
      expect(rejected.output).toBe('');
    }
  });

  it('runs the provider alone with bounded structured output and every bypass disabled', () => {
    const prepare = readWorkflow().jobs['resolve-prepare']!;
    const propose = readWorkflow().jobs['resolve-propose']!;
    const schema = findStep(prepare, 'Bind trusted resolver inputs');
    const setupNode = propose.steps.find(step => step.uses === ACTION_PINS.setupNode)!;
    const provider = findStep(propose, 'Generate tool-less structured proposal');
    const extract = findStep(propose, 'Extract and locally validate structured proposal');
    const secretSteps = propose.steps.filter(step => (
      JSON.stringify(step.env ?? {}).includes('ANTHROPIC_API_KEY')
    ));

    expect(secretSteps).toEqual([provider]);
    expect(setupNode.with?.['node-version']).toBe(22);
    expect(provider['working-directory']).toBe('${{ runner.temp }}/resolve-provider/work');
    expect(provider.env).toMatchObject({
      HOME: '${{ runner.temp }}/resolve-provider/home',
      XDG_CONFIG_HOME: '${{ runner.temp }}/resolve-provider/home/xdg',
    });
    expect(provider.run).toContain('--input-format text --output-format json');
    expect(provider.run).toContain('--bare --safe-mode');
    expect(provider.run).toContain("--tools ''");
    expect(provider.run).toContain(
      "--disallowedTools 'Bash,WebFetch,WebSearch,mcp__*'",
    );
    expect(provider.run).toContain('--strict-mcp-config');
    expect(provider.run).toContain('--no-chrome --disable-slash-commands');
    expect(provider.run).toContain("--setting-sources ''");
    expect(provider.run).toContain('--permission-mode dontAsk --no-session-persistence');
    expect(provider.run).toContain('3145728');
    expect(extract.run).toContain("response.structured_output");
    expect(extract.run).toContain("response.type !== 'result'");
    expect(extract.run).toContain("response.subtype !== 'success'");
    expect(extract.run).toContain('response.is_error !== false');
    expect(schema.run).toContain("action: { const: 'replace' }");
    expect(schema.run).toContain("action: { const: 'delete' }");
    expect(extract.run).toContain("conflict.kind !== 'modify-delete'");
    expect(extract.run).toContain('2097152');
  });

  it('creates the immutable candidate before a separate runner executes PR code', () => {
    const applyJob = readWorkflow().jobs['resolve-apply']!;
    const testJob = readWorkflow().jobs['resolve-test']!;
    const apply = findStep(applyJob, 'Recreate exact merge and apply proposal');
    const bind = findStep(applyJob, 'Bind immutable candidate patch');
    const upload = findStep(applyJob, 'Upload immutable candidate artifact');
    const replay = findStep(testJob, 'Reproduce exact candidate before testing');
    const validate = findStep(testJob, 'Run full build and test without secrets');
    const verify = findStep(testJob, 'Verify tests did not mutate candidate');

    expect(apply.run).toContain('resolve-conflicts-contract.mjs" \\');
    expect(apply.run).toMatch(/\n\s+apply /u);
    expect(apply.run).toContain('git diff --cached --binary --full-index');
    expect(bind.run).toContain('input_sha256');
    expect(bind.run).toContain('proposal_sha256');
    expect(bind.run).toContain('patch_sha256');
    expect(upload.with?.name).toBe('resolve-candidate-${{ github.run_id }}');
    expect(JSON.stringify(applyJob)).not.toMatch(/npm test|npm run build/iu);
    expect(testJob.steps.some(step => step.uses === ACTION_PINS.uploadArtifact)).toBe(false);
    expect(replay.run).toContain('resolve-conflicts-contract.mjs" \\');
    expect(replay.run).toContain('cmp -- "$CANDIDATE_DIR/candidate.patch"');
    expect(apply.run).toContain('const marker = /^(<{7,}|\\|{7,}|={7,}|>{7,})');
    expect(testJob.steps.indexOf(verify)).toBeGreaterThan(testJob.steps.indexOf(validate));
    expect(verify.run).toContain('git diff --exit-code');
    expect(verify.run).toContain('git diff --cached --binary --full-index');
    expect(verify.run).toContain('cmp -- "$CANDIDATE_DIR/candidate.patch"');
    expect(verify.run).toContain('git ls-files --others --exclude-standard');
    expect(validate.run?.trim().split('\n')).toEqual([
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm run build',
      'npm test',
    ]);
  });

  it('fails closed when a mutation crosses the resolve execution boundaries', () => {
    const workflow = readWorkflow();
    const apply = workflow.jobs['resolve-apply']!;
    const test = workflow.jobs['resolve-test']!;
    const publish = workflow.jobs['resolve-publish']!;
    const candidateDownloadIndex = publish.steps.findIndex(
      step => step.name === 'Download exact candidate artifact',
    );
    const cases: WorkflowContract[] = [
      {
        ...workflow,
        jobs: {
          ...workflow.jobs,
          'resolve-apply': {
            ...apply,
            steps: [...apply.steps, { name: 'Run untrusted tests too early', run: 'npm test' }],
          },
        },
      },
      {
        ...workflow,
        jobs: {
          ...workflow.jobs,
          'resolve-test': {
            ...test,
            outputs: { artifact_id: '${{ steps.mutated.outputs.artifact-id }}' },
            steps: [
              ...test.steps,
              { name: 'Upload mutable result', uses: ACTION_PINS.uploadArtifact },
            ],
          },
        },
      },
      {
        ...workflow,
        jobs: {
          ...workflow.jobs,
          'resolve-publish': {
            ...publish,
            steps: publish.steps.map((step, index) => (
              index === candidateDownloadIndex
                ? { ...step, with: { ...step.with, 'artifact-ids': '${{ needs.resolve-test.outputs.artifact_id }}' } }
                : step
            )),
          },
        },
      },
    ];

    for (const mutated of cases) {
      expect(() => assertResolveExecutionBoundary(mutated)).toThrow();
    }
  });

  it('publishes only reproduced tested bytes and exposes the token only while pushing', () => {
    const publish = readWorkflow().jobs['resolve-publish']!;
    const reapply = findStep(publish, 'Reapply only the tested candidate');
    const push = findStep(publish, 'Push exact candidate commit with lease');
    const confirm = findStep(publish, 'Confirm push and CI validation');
    const tokenSteps = publish.steps.filter(step => (
      JSON.stringify(step.env ?? {}).includes('github.token')
    ));

    expect(tokenSteps).toEqual([push]);
    expect(JSON.stringify(publish)).not.toMatch(/npm test|npm run|ANTHROPIC/iu);
    expect(reapply.run).toContain('resolve-conflicts-contract.mjs" \\');
    expect(reapply.run).toMatch(/\n\s+apply /u);
    expect(reapply.run).toContain('cmp -- "$CANDIDATE_DIR/candidate.patch"');
    expect(reapply.run).toContain('prepare_artifact_id');
    expect(reapply.run).toContain('proposal_artifact_id');
    expect(reapply.run).toContain('input_sha256');
    expect(reapply.run).toContain('proposal_sha256');
    expect(reapply.run).toContain('patch_sha256');
    expect(push.run).toContain('gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER"');
    expect(push.run).toContain("'.head.repo.full_name'");
    expect(push.run).toContain("'.head.ref'");
    expect(push.run).toContain("'.head.sha'");
    expect(push.run).toContain("'.base.sha'");
    expect(push.run).toContain("'.state'");
    expect(push.run).toContain("'.merged'");
    expect(push.run).toContain("'.default_branch'");
    expect(push.run).toContain('test "$BRANCH" != "$default_branch"');
    expect(push.run).toContain('--force-with-lease="refs/heads/$BRANCH:$HEAD_SHA"');
    expect(confirm.if).toBe("${{ steps.push.outputs.pushed == 'true' }}");
  });

  it.each([
    ['OR changed to AND', (condition: string) => condition.replace(/\|\|/u, '&&')],
    ['unconditional suffix', (condition: string) => `${condition.trim()} || true`],
    [
      'association added',
      (condition: string) => condition.replace(
        '"COLLABORATOR"]', '"COLLABORATOR", "CONTRIBUTOR"]',
      ),
    ],
    [
      'association case changed',
      (condition: string) => condition.replace('"OWNER"', '"owner"'),
    ],
  ] as const)('fails closed when source mutation changes semantics: %s', (
    _description,
    mutate,
  ) => {
    const condition = readWorkflow().jobs.review!.if!;
    expect(() => compileReviewCondition(mutate(condition))).toThrow();
  });

  it('runs review only from the immutable trusted base with a fixed builtin workflow', () => {
    const workflow = readWorkflow();
    const review = workflow.jobs.review!;
    const checkout = review.steps.find(step => step.uses === ACTION_PINS.checkout)!;
    const run = findStep(review, 'Run trusted TAKT review');
    const allSource = JSON.stringify(review);

    expect(workflow.permissions).toEqual({});
    expect(review.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(checkout.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
    expect(allSource).not.toMatch(/steps\.pr\.outputs|github\.event\.pull_request\.head/iu);
    expect(run['working-directory']).toBe('${{ runner.temp }}/takt-review-workspace');
    expect(run.run).toContain('"$GITHUB_WORKSPACE/dist/app/cli/index.js"');
    expect(run.run).toContain(
      '-w "$GITHUB_WORKSPACE/builtins/en/workflows/review-takt-default.yaml"',
    );
    expect(run.run).toContain('--provider claude');
    expect(run.run).toContain('--task "$REVIEW_TASK"');
    expect(run.run).not.toMatch(/(?:^|\s)--pr(?:\s|$)/u);
    expect(run.run).not.toMatch(/npm install|npm exec|\bbash\b|\bsh\b/iu);
  });

  it('isolates project/user overrides and removes agent shell, web, and extension routes', () => {
    const review = readWorkflow().jobs.review!;
    const run = findStep(review, 'Run trusted TAKT review');
    const providerOptions = JSON.parse(run.env!.TAKT_PROVIDER_OPTIONS!) as {
      claude: { allowed_tools: string[] };
      codex: { network_access: boolean; skills: { repo: boolean; user: boolean } };
      opencode: { network_access: boolean; allowed_tools: string[] };
    };

    expect(run.env).toMatchObject({
      HOME: '${{ runner.temp }}/takt-review-home',
      XDG_CONFIG_HOME: '${{ runner.temp }}/takt-review-home/xdg',
      TAKT_OBSERVABILITY_ENABLED: 'false',
      TAKT_WORKFLOW_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES: 'false',
      TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES: 'false',
      TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_INLINE_JS: 'false',
      TAKT_WORKFLOW_COMMAND_GATES_CUSTOM_SCRIPTS: 'false',
      TAKT_WORKFLOW_MCP_SERVERS_HTTP: 'false',
      TAKT_WORKFLOW_MCP_SERVERS_SSE: 'false',
      TAKT_WORKFLOW_MCP_SERVERS_STDIO: 'false',
      TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS: 'false',
    });
    expect(providerOptions).toEqual({
      claude: { allowed_tools: [] },
      codex: {
        network_access: false,
        skills: { repo: false, user: false },
      },
      opencode: {
        network_access: false,
        allowed_tools: [],
      },
    });
    expect(JSON.stringify(providerOptions)).not.toMatch(
      /bash|shell|websearch|webfetch|network_access":true/iu,
    );
  });

  it('inlines every parallel review result for the tool-less supervisor', () => {
    const builtin = parseYaml(readFileSync(reviewWorkflowPath, 'utf8')) as {
      steps: Array<{
        name: string;
        parallel?: Array<{ name: string }>;
        pass_previous_response?: boolean;
        previous_response_max_bytes?: number;
        previous_response_overflow?: string;
        instruction?: string;
      }>;
    };
    const reviewers = builtin.steps.find(step => step.name === 'reviewers');
    const supervise = builtin.steps.find(step => step.name === 'supervise');

    expect(reviewers?.parallel?.map(step => step.name)).toEqual([
      'arch-review',
      'security-review',
      'qa-review',
      'testing-review',
      'ai-antipattern-review-2nd',
      'pure-review',
      'coding-review',
    ]);
    // The provider has no tools in this workflow, so the engine's bounded
    // previous-response channel is the supervisor's only review-data input.
    expect(supervise?.pass_previous_response).toBe(true);
    expect(supervise?.previous_response_max_bytes).toBe(65_536);
    expect(supervise?.previous_response_overflow).toBe('error');
    expect(supervise?.instruction).toContain('{previous_response}');
  });

  it('separates immutable PR data collection from provider-secret execution', () => {
    const review = readWorkflow().jobs.review!;
    const run = findStep(review, 'Run trusted TAKT review');
    const collect = findStep(review, 'Collect immutable PR data without provider secrets');
    const secretSteps = review.steps.filter(step => (
      JSON.stringify(step.env ?? {}).includes('ANTHROPIC_API_KEY')
    ));

    expect(secretSteps).toEqual([run]);
    expect(run.env).toMatchObject({
      ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}',
    });
    expect(run.env).not.toHaveProperty('GH_TOKEN');
    expect(collect.env).toMatchObject({
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      PR_NUMBER: '${{ github.event.issue.number }}',
    });
    expect(collect.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(collect.run).toContain("PR-METADATA.json");
    expect(collect.run).toContain("PR-DIFF.patch");
    expect(collect.run).toContain('head_before');
    expect(collect.run).toContain('base_sha');
    expect(collect.run).toContain('head_after');
    expect(collect.run).toContain('compare/${base_sha}...${head_before}');
    expect(collect.run).not.toContain('pulls/${PR_NUMBER}" \\\n      -H \'Accept: application/vnd.github.v3.diff\'');
    expect(collect.run).toContain('98304');
    expect(collect.run).toContain("new TextDecoder('utf-8', { fatal: true })");
    expect(collect.run).toContain("includes('\\0')");
    expect(collect.run).toContain('REVIEW_TASK_B64');
    expect(collect.run).not.toMatch(/eval|source\s|\.[ \\t]+PR-/iu);
    expect(run.run).toContain('base64 --decode');
    expect(run.run).not.toMatch(/PR-METADATA\.json|PR-DIFF\.patch|\b(?:cat|find|grep)\b/iu);
    expect(run.env?.TAKT_PROVIDER_OPTIONS).toContain('"allowed_tools":[]');
  });

  it('installs a verified exact Claude Code version before exposing the provider secret', () => {
    const review = readWorkflow().jobs.review!;
    const run = findStep(review, 'Run trusted TAKT review');
    const setupNode = review.steps.find(step => step.uses === ACTION_PINS.setupNode)!;

    assertTrustedClaudeInstall(review, 'Run trusted TAKT review');
    expect(setupNode.with?.['node-version']).toBe(22);
    expect(run.env?.TAKT_CLAUDE_CLI_PATH).toBe(
      '${{ runner.temp }}/claude-code-toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude',
    );

    const withoutInstall: WorkflowJob = {
      ...review,
      steps: review.steps.filter(step => step.name !== 'Install trusted Claude Code'),
    };
    expect(() => assertTrustedClaudeInstall(
      withoutInstall,
      'Run trusted TAKT review',
    )).toThrow(/missing workflow step: Install trusted Claude Code/u);
  });

  it('uses the same lifecycle-disabled exact Claude Code install for resolve', () => {
    const propose = readWorkflow().jobs['resolve-propose']!;
    const install = findStep(propose, 'Validate prepare binding and install locked provider');
    const run = findStep(propose, 'Generate tool-less structured proposal');

    expect(install.run).toContain(
      'npm ci --prefix "$TOOLCHAIN_DIR" --ignore-scripts --no-audit --no-fund',
    );
    expect(install.run).toContain(
      'npm audit --prefix "$TOOLCHAIN_DIR" --audit-level=high --omit=dev',
    );
    expect(install.run).not.toMatch(/npm install|--global|@(?:latest|next|beta)\b/u);
    expect(run.run).toContain(
      '"$RUNNER_TEMP/claude-code-toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude"',
    );
    expect(run.run).toContain("--tools ''");
    expect(run.run).toContain('--output-format json');
    expect(run.run).toContain('--json-schema "$schema"');
    expect(run.run).toContain('--strict-mcp-config');
    expect(run.run).toContain('--permission-mode dontAsk');
    expect(run.run).toContain('--no-session-persistence');
    expect(run.run).not.toContain('--dangerously-skip-permissions');
  });

  it('locks the dedicated Claude Code toolchain including every installed package', () => {
    const manifest = JSON.parse(readFileSync(claudeToolchainManifestPath, 'utf8')) as {
      private?: boolean;
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(claudeToolchainLockPath, 'utf8')) as {
      lockfileVersion?: number;
      packages?: Record<string, {
        version?: string;
        resolved?: string;
        integrity?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }>;
    };

    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({ '@anthropic-ai/claude-code': '2.1.220' });
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages?.['']?.version).toBeUndefined();
    expect(lock.packages?.['']).toMatchObject({
      dependencies: { '@anthropic-ai/claude-code': '2.1.220' },
    });
    expect(lock.packages?.['node_modules/@anthropic-ai/claude-code']).toMatchObject({
      version: '2.1.220',
    });
    expect(lock.packages?.['node_modules/@anthropic-ai/claude-code-linux-x64']).toMatchObject({
      version: '2.1.220',
    });

    const installedPackages = Object.entries(lock.packages ?? {})
      .filter(([path]) => path.startsWith('node_modules/'));
    expect(installedPackages.length).toBeGreaterThan(0);
    for (const [path, pkg] of installedPackages) {
      expect(pkg.version, `${path} must have an exact version`).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
      expect(pkg.resolved, `${path} must have a resolved artifact`).toMatch(/^https:\/\//u);
      expect(pkg.integrity, `${path} must have integrity`).toMatch(/^sha512-/u);
      for (const dependency of Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
      })) {
        expect(
          installedPackages.some(([candidate]) => (
            candidate === `node_modules/${dependency}`
            || candidate.endsWith(`/node_modules/${dependency}`)
          )),
          `${path} dependency ${dependency} must have a locked package`,
        ).toBe(true);
      }
    }
  });

  it('executes the trusted builder and embeds bounded PR bytes into one task', () => {
    const result = runTaskBuilder(
      Buffer.from('{"head":{"sha":"abc"}}', 'utf8'),
      Buffer.from('diff --git a/a b/a\n', 'utf8'),
    );
    expect(result.success).toBe(true);
    expect(result.taskExists).toBe(true);
    expect(result.task).toContain('<PR_METADATA>');
    expect(result.task).toContain('<PR_DIFF>');
  });

  it.each([
    ['invalid metadata UTF-8', Buffer.from([0xc3, 0x28]), Buffer.from('diff')],
    ['metadata NUL', Buffer.from('meta\0data'), Buffer.from('diff')],
    ['diff NUL', Buffer.from('metadata'), Buffer.from('diff\0data')],
    ['metadata limit', Buffer.alloc(16385, 0x61), Buffer.from('diff')],
    ['diff limit', Buffer.from('metadata'), Buffer.alloc(65537, 0x61)],
  ])('executes the trusted builder and rejects %s without a task', (
    _description,
    metadata,
    diff,
  ) => {
    const result = runTaskBuilder(metadata, diff);
    expect(result.success).toBe(false);
    expect(result.taskExists).toBe(false);
  });

  it('publishes only the exact verified report artifact without checkout or provider secret', () => {
    const workflow = readWorkflow();
    const review = workflow.jobs.review!;
    const publish = workflow.jobs['publish-review']!;
    const upload = findStep(review, 'reports');
    const download = publish.steps.find(step => step.uses === ACTION_PINS.downloadArtifact)!;
    const post = findStep(publish, 'Validate and publish review report');

    expect(review.outputs).toEqual({
      artifact_id: '${{ steps.reports.outputs.artifact-id }}',
      reviewed_head_sha: '${{ steps.pr-data.outputs.head_sha }}',
    });
    expect(upload.with).toMatchObject({
      name: 'takt-review-report',
      path: '${{ runner.temp }}/takt-review-artifact',
      'if-no-files-found': 'error',
    });
    expect(publish.needs).toBe('review');
    expect(publish.permissions).toEqual({ 'pull-requests': 'write' });
    expect(download.with).toMatchObject({
      'artifact-ids': '${{ needs.review.outputs.artifact_id }}',
      path: '${{ runner.temp }}/takt-review-publish',
      'merge-multiple': true,
    });
    expect(publish.steps.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(JSON.stringify(publish)).not.toMatch(/ANTHROPIC|TAKT_PROVIDER|npm install/iu);
    expect(post.uses).toBe(ACTION_PINS.githubScript);
    expect(post.with?.script).toContain("lstatSync(reportPath)");
    expect(post.with?.script).toContain("createHash('sha256')");
    expect(post.with?.script).toContain('timingSafeEqual');
    expect(post.with?.script).toContain('new TextDecoder');
    expect(post.with?.script).toContain('github.rest.pulls.createReview');
    expect(post.with?.script).toContain('commit_id: expectedHead');
    expect(post.with?.script).toContain('github.rest.pulls.get');
    expect(post.env?.EXPECTED_HEAD_SHA).toBe('${{ needs.review.outputs.reviewed_head_sha }}');
  });

  it('pins every external action to a reviewed full commit SHA', () => {
    const actionUses = Object.values(readWorkflow().jobs)
      .flatMap(job => job.steps)
      .map(step => step.uses)
      .filter((uses): uses is string => typeof uses === 'string');
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every(
      uses => /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/u.test(uses),
    )).toBe(true);
    expect(new Set(actionUses)).toEqual(new Set(Object.values(ACTION_PINS)));
  });

  it('executes the publisher and posts exactly one validated current-head report', async () => {
    const result = await runPublisher();
    expect(result.failures).toEqual([]);
    expect(result.comments).toEqual(['verified review']);
    expect(result.reviewCommits).toEqual([REVIEWED_HEAD_SHA]);
  });

  it.each([
    ['symlink', { symlinkReport: true }],
    ['oversize', { report: Buffer.alloc(65537, 0x61) }],
    ['manifest grammar', { manifest: 'not-a-manifest\n' }],
    ['digest mismatch', { manifest: manifestWithReportDigest('0'.repeat(64)) }],
    ['invalid UTF-8', { report: Buffer.from([0xc3, 0x28]) }],
    ['NUL', { report: Buffer.from('review\0body', 'utf8') }],
    ['missing report', { missing: 'report' as const }],
    ['missing manifest', { missing: 'manifest' as const }],
    ['missing reviewed head', { missing: 'head' as const }],
    ['extra path', { extraPath: true }],
    ['artifact head mismatch', { artifactHead: 'f'.repeat(40) }],
    ['stale current head', { currentHead: 'e'.repeat(40) }],
  ])('executes the publisher and rejects %s before posting', async (
    _description,
    fixture,
  ) => {
    const result = await runPublisher(fixture);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.comments).toEqual([]);
  });

  it('publisher harness detects a validation-before-post mutation', async () => {
    const source = findStep(
      readWorkflow().jobs['publish-review']!,
      'Validate and publish review report',
    ).with!.script as string;
    const mutated = source.replace(
      "core.setFailed('Review artifact digest mismatch.');\n  return;",
      "core.setFailed('Review artifact digest mismatch.');",
    );
    expect(mutated).not.toBe(source);

    const result = await runPublisher({
      manifest: manifestWithReportDigest('0'.repeat(64)),
    }, mutated);
    expect(result.comments).toEqual(['verified review']);
  });

  it('builds Slack JSON from an untrusted issue title without markup interpolation', () => {
    const takt = readWorkflow().jobs.takt!;
    const prepare = findStep(takt, 'Prepare Slack payload');
    const notify = findStep(takt, 'Notify Slack');
    const script = prepare.run!.match(/node <<'NODE'\n([\s\S]*?)\nNODE/u)?.[1];
    expect(script, 'missing trusted Slack payload builder').toBeDefined();
    expect(prepare.run).not.toContain('${{ github.event.issue.title }}');
    expect(notify.uses).toBe(ACTION_PINS.slack);
    expect(notify.with).toMatchObject({
      'payload-file-path': '${{ runner.temp }}/takt-slack-payload.json',
    });
    expect(notify.with).not.toHaveProperty('payload');

    const root = mkdtempSync(resolve(tmpdir(), 'takt-slack-payload-'));
    temporaryDirectories.push(root);
    const payloadPath = resolve(root, 'payload.json');
    const maliciousTitle = '"}\n<!channel> <@U123> & <script>';
    execFileSync('node', ['-'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTOR_LOGIN: 'reviewer',
        ISSUE_NUMBER: '164',
        ISSUE_TITLE: maliciousTitle,
        JOB_STATUS: 'failure',
        REPOSITORY: 'owner/repo',
        RUN_ID: '1234',
        SERVER_URL: 'https://github.com',
        SLACK_PAYLOAD_PATH: payloadPath,
      },
      input: script,
    });
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as {
      blocks: Array<{ text?: { type?: string; text?: string } }>;
    };
    const titleBlock = payload.blocks.find(block => block.text?.type === 'plain_text');
    expect(titleBlock?.text?.text).toBe(maliciousTitle);
    expect(payload.blocks
      .filter(block => block.text?.type === 'mrkdwn')
      .every(block => !block.text?.text?.includes(maliciousTitle))).toBe(true);
  });

  it('never interpolates untrusted comment or PR data into any shell script', () => {
    const scripts = Object.values(readWorkflow().jobs)
      .flatMap(job => job.steps.map(step => step.run ?? ''))
      .join('\n');
    expect(scripts).not.toMatch(
      /\$\{\{\s*github\.event\.(?:comment|issue\.(?:title|body)|pull_request)/u,
    );
    expect(scripts).not.toContain('${{ steps.pr.outputs.branch }}');
  });

  it('passes the candidate branch through env and uses an explicit CAS lease refspec', () => {
    const publish = readWorkflow().jobs['resolve-publish']!;
    const push = findStep(publish, 'Push exact candidate commit with lease');

    expect(push.env).toMatchObject({
      BRANCH: '${{ needs.resolve-prepare.outputs.branch }}',
      DEFAULT_BRANCH: '${{ needs.resolve-prepare.outputs.default_branch }}',
      HEAD_SHA: '${{ needs.resolve-prepare.outputs.head_sha }}',
    });
    expect(push.run).toContain('git check-ref-format --branch "$BRANCH"');
    expect(push.run).toContain('--force-with-lease="refs/heads/$BRANCH:$HEAD_SHA"');
    expect(push.run).not.toContain('${{ needs.resolve-prepare.outputs.branch }}');
  });

  it('executes the publish boundary with a CAS lease and rejects stale, missing, or raced heads', () => {
    const expectedHead = '0123456789abcdef0123456789abcdef01234567';
    const success = executeResolvePushFixture({ remoteHead: expectedHead });
    expect(success.status).toBe(0);
    expect(success.gitLog).toContain(
      'push --force-with-lease=refs/heads/fix/conflicts:0123456789abcdef0123456789abcdef01234567',
    );
    expect(success.output).toContain('pushed=true');

    for (const fixture of [
      { remoteHead: '' },
      { remoteHead: 'f'.repeat(40) },
      { remoteHead: expectedHead, leaseReject: true },
    ]) {
      const rejected = executeResolvePushFixture(fixture);
      expect(rejected.status).not.toBe(0);
      expect(rejected.output).toBe('');
    }
  });

  it('executes the publish boundary only for a live open unmerged non-default head', () => {
    const expectedHead = '0123456789abcdef0123456789abcdef01234567';
    for (const fixture of [
      { remoteHead: expectedHead, state: 'closed' as const },
      { remoteHead: expectedHead, merged: true },
      { remoteHead: expectedHead, branch: 'main' },
    ]) {
      const rejected = executeResolvePushFixture(fixture);
      expect(rejected.status).not.toBe(0);
      expect(rejected.gitLog).not.toContain(' push ');
      expect(rejected.output).toBe('');
    }
  });
});
