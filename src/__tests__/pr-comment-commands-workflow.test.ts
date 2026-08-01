import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
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
const ACTION_PINS = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  downloadArtifact: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  githubScript: 'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
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
  readonly needs?: string;
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

function compileReviewCondition(
  condition: string,
): (event: ReviewEventFixture) => boolean {
  const normalized = condition.replace(/\s+/gu, ' ').trim();
  const semanticShape = normalized.match(
    /^github\.event\.issue\.pull_request != null && \( github\.event\.comment\.body == '(\/[a-z]+)' \|\| startsWith\(github\.event\.comment\.body, '\1 '\) \|\| startsWith\(github\.event\.comment\.body, format\('\1\{0\}', fromJSON\('"\\n"'\)\)\) \) && contains\(fromJSON\('(\[[^']+\])'\), github\.event\.comment\.author_association\)$/u,
  );
  if (semanticShape === null) {
    throw new Error('review condition is outside the closed security grammar');
  }

  const command = semanticShape[1]!;
  const allowedAssociations = JSON.parse(semanticShape[2]!) as unknown;
  if (!Array.isArray(allowedAssociations)
    || allowedAssociations.some(value => typeof value !== 'string')
    || JSON.stringify(allowedAssociations) !== JSON.stringify([
      'OWNER', 'MEMBER', 'COLLABORATOR',
    ])) {
    throw new Error('review condition changed the trusted association set');
  }

  return (event) => event.isPullRequest
    && (
      event.body === command
      || event.body.startsWith(`${command} `)
      || event.body.startsWith(`${command}\n`)
    )
    && allowedAssociations.includes(event.authorAssociation);
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
): Promise<{ readonly comments: string[]; readonly failures: string[] }> {
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
  const failures: string[] = [];
  let currentHeadChecked = false;
  const github = {
    rest: {
      issues: {
        createComment: async ({ body }: { body: string }) => {
          if (!currentHeadChecked) {
            throw new Error('publisher posted before current-head validation');
          }
          comments.push(body);
        },
      },
      pulls: {
        get: async () => {
          currentHeadChecked = true;
          return { data: { head: { sha: fixture.currentHead ?? REVIEWED_HEAD_SHA } } };
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
  return { comments, failures };
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
    expect(post.with?.script).toContain('github.rest.issues.createComment');
    expect(post.with?.script).toContain('github.rest.pulls.get');
    expect(post.env?.EXPECTED_HEAD_SHA).toBe('${{ needs.review.outputs.reviewed_head_sha }}');
  });

  it('pins every first-party action to a reviewed full commit SHA', () => {
    const actionUses = Object.values(readWorkflow().jobs)
      .flatMap(job => job.steps)
      .map(step => step.uses)
      .filter((uses): uses is string => uses?.startsWith('actions/') === true);
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every(uses => /^actions\/[a-z-]+@[0-9a-f]{40}$/u.test(uses))).toBe(true);
    expect(new Set(actionUses)).toEqual(new Set(Object.values(ACTION_PINS)));
  });

  it('executes the publisher and posts exactly one validated current-head report', async () => {
    const result = await runPublisher();
    expect(result.failures).toEqual([]);
    expect(result.comments).toEqual(['verified review']);
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

  it('never interpolates untrusted comment or PR data into a shell script', () => {
    const review = readWorkflow().jobs.review!;
    const scripts = review.steps
      .map(step => step.run ?? '')
      .join('\n');
    expect(scripts).not.toMatch(
      /\$\{\{\s*github\.event\.(?:comment|issue\.(?:title|body)|pull_request)/u,
    );
  });
});
