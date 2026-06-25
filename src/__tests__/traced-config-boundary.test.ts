import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadGlobalConfigTrace, loadProjectConfigTrace } from '../infra/config/traced/tracedConfigLoader.js';
import { getGlobalTracedSchema, getProjectTracedSchema } from '../infra/config/traced/tracedConfigSchema.js';
import { loadTraceEntriesViaRuntime } from '../infra/config/traced/tracedConfigRuntimeBridge.js';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

let taktEnvSnapshot: TaktEnvSnapshot;

describe('traced config boundaries', () => {
  beforeEach(() => {
    taktEnvSnapshot = clearTaktEnv();
  });

  afterEach(() => {
    restoreTaktEnv(taktEnvSnapshot);
    vi.restoreAllMocks();
  });

  it('runtime bridge keeps parent/child traced origins with actual traced-config runtime', () => {
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'true';

    const traceEntries = loadTraceEntriesViaRuntime({
      'provider_options': {
        doc: 'provider_options',
        format: 'json',
        env: 'TAKT_PROVIDER_OPTIONS',
        sources: { local: true, global: false, env: false, cli: false },
      },
      'provider_options.codex.network_access': {
        doc: 'provider_options.codex.network_access',
        format: Boolean,
        env: 'TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS',
        sources: { local: true, global: false, env: true, cli: false },
      },
    }, 'local', {
      provider_options: {
        codex: {
          network_access: false,
        },
      },
    });

    expect(traceEntries.get('provider_options')?.origin).toBe('local');
    expect(traceEntries.get('provider_options.codex.network_access')?.origin).toBe('env');
  });

  it('global/project traced schema は全キーで cli を無効化する', () => {
    expect(Object.values(getGlobalTracedSchema()).every((entry) => entry.sources?.cli === false)).toBe(true);
    expect(Object.values(getProjectTracedSchema()).every((entry) => entry.sources?.cli === false)).toBe(true);
    expect(getProjectTracedSchema()['provider_options.claude.allowed_tools']?.sources?.env).toBe(false);
    expect(getProjectTracedSchema()['observability.enabled']?.sources?.env).toBe(true);
    expect(getGlobalTracedSchema()['observability.usage_events_phase']?.sources?.env).toBe(true);
    expect(getProjectTracedSchema().sync_project_local_takt_on_retry?.sources?.env).toBe(true);
    expect(getGlobalTracedSchema().sync_project_local_takt_on_retry?.sources?.env).toBe(true);
  });

  it('project traced schema は非許可 env を runtime bridge でも無視する', () => {
    process.env.TAKT_PROVIDER_OPTIONS_CLAUDE_ALLOWED_TOOLS = '["Bash"]';

    const traceEntries = loadTraceEntriesViaRuntime(
      getProjectTracedSchema(),
      'local',
      {
        provider_options: {
          claude: {
            allowed_tools: ['Read'],
          },
        },
      },
    );

    expect(traceEntries.get('provider_options.claude.allowed_tools')?.origin).toBe('local');
  });

  it('project config loader は root JSON env override の opaque ancestor 規則を rawConfig と origin 解決で共有する', () => {
    const tempDir = join(tmpdir(), `takt-traced-loader-${randomUUID()}`);
    const configDir = join(tempDir, '.takt');
    const configPath = join(configDir, 'config.yaml');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        'provider_options:',
        '  codex:',
        '    network_access: false',
        '  claude:',
        '    allowed_tools:',
        '      - Read',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS = JSON.stringify({
      claude: {
        allowed_tools: ['Bash'],
      },
    });

    try {
      const { rawConfig, trace } = loadProjectConfigTrace(configPath, []);

      expect(rawConfig).toEqual({
        provider_options: {
          claude: {
            allowed_tools: ['Bash'],
          },
        },
      });
      expect(trace.getOrigin('provider_options.claude.allowed_tools')).toBe('env');
      expect(trace.getOrigin('provider_options.codex.network_access')).toBe('env');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('project config loader は TAKT_PERSONA_PROVIDERS の nested provider_options を traced config 経路で保持する', () => {
    const tempDir = join(tmpdir(), `takt-traced-persona-providers-${randomUUID()}`);
    const configDir = join(tempDir, '.takt');
    const configPath = join(configDir, 'config.yaml');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        'persona_providers:',
        '  coder:',
        '    provider: codex',
        '    provider_options:',
        '      codex:',
        '        reasoning_effort: low',
      ].join('\n'),
      'utf-8',
    );
    process.env.TAKT_PERSONA_PROVIDERS = JSON.stringify({
      coder: {
        provider: 'codex',
        provider_options: {
          codex: {
            reasoning_effort: 'high',
          },
        },
      },
    });

    try {
      const { rawConfig, trace } = loadProjectConfigTrace(configPath, []);

      expect(rawConfig).toEqual({
        persona_providers: {
          coder: {
            provider: 'codex',
            provider_options: {
              codex: {
                reasoning_effort: 'high',
              },
            },
          },
        },
      });
      expect(trace.getOrigin('persona_providers.coder.provider_options')).toBe('env');
      expect(trace.getOrigin('persona_providers.coder.provider_options.codex.reasoning_effort')).toBe('env');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_profiles は provider と step override 単位で raw config と origin を追跡する', () => {
    const tempDir = join(tmpdir(), `takt-traced-provider-profiles-${randomUUID()}`);
    const projectConfigDir = join(tempDir, 'project', '.takt');
    const globalConfigDir = join(tempDir, 'global');
    const projectConfigPath = join(projectConfigDir, 'config.yaml');
    const globalConfigPath = join(globalConfigDir, 'config.yaml');
    mkdirSync(projectConfigDir, { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(
      projectConfigPath,
      [
        'provider_profiles:',
        '  claude:',
        '    default_permission_mode: full',
        '    step_permission_overrides:',
        '      review: edit',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      globalConfigPath,
      [
        'provider_profiles:',
        '  codex:',
        '    default_permission_mode: edit',
        '    step_permission_overrides:',
        '      implement: full',
      ].join('\n'),
      'utf-8',
    );

    try {
      const projectTraceResult = loadProjectConfigTrace(projectConfigPath, []);
      const globalTraceResult = loadGlobalConfigTrace(globalConfigPath, (value) => value, []);

      expect(projectTraceResult.rawConfig.provider_profiles).toEqual({
        claude: {
          default_permission_mode: 'full',
          step_permission_overrides: {
            review: 'edit',
          },
        },
      });
      expect(globalTraceResult.rawConfig.provider_profiles).toEqual({
        codex: {
          default_permission_mode: 'edit',
          step_permission_overrides: {
            implement: 'full',
          },
        },
      });
      expect(projectTraceResult.trace.getOrigin('provider_profiles.claude.default_permission_mode')).toBe('local');
      expect(projectTraceResult.trace.getOrigin('provider_profiles.claude.step_permission_overrides.review')).toBe('local');
      expect(globalTraceResult.trace.getOrigin('provider_profiles.codex.default_permission_mode')).toBe('global');
      expect(globalTraceResult.trace.getOrigin('provider_profiles.codex.step_permission_overrides.implement')).toBe('global');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('project/global config loader は sync_project_local_takt_on_retry の origin を env として記録する', () => {
    const tempDir = join(tmpdir(), `takt-traced-sync-retry-${randomUUID()}`);
    const projectConfigDir = join(tempDir, 'project', '.takt');
    const globalConfigDir = join(tempDir, 'global');
    const projectConfigPath = join(projectConfigDir, 'config.yaml');
    const globalConfigPath = join(globalConfigDir, 'config.yaml');
    mkdirSync(projectConfigDir, { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(projectConfigPath, 'sync_project_local_takt_on_retry: false\n', 'utf-8');
    writeFileSync(globalConfigPath, ['language: ja', 'sync_project_local_takt_on_retry: true'].join('\n'), 'utf-8');
    process.env.TAKT_SYNC_PROJECT_LOCAL_TAKT_ON_RETRY = 'true';

    try {
      const projectTraceResult = loadProjectConfigTrace(projectConfigPath, []);
      const globalTraceResult = loadGlobalConfigTrace(globalConfigPath, (value) => value, []);

      expect(projectTraceResult.rawConfig.sync_project_local_takt_on_retry).toBe(true);
      expect(projectTraceResult.trace.getOrigin('sync_project_local_takt_on_retry')).toBe('env');
      expect(globalTraceResult.rawConfig.sync_project_local_takt_on_retry).toBe(true);
      expect(globalTraceResult.trace.getOrigin('sync_project_local_takt_on_retry')).toBe('env');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runtime bridge は cwd 配下の偽 traced-config を読まずに TAKT 同梱依存を使う', () => {
    const tempDir = join(tmpdir(), `takt-traced-runtime-${randomUUID()}`);
    const fakeModuleDir = join(tempDir, 'node_modules', 'traced-config');
    mkdirSync(fakeModuleDir, { recursive: true });
    writeFileSync(
      join(fakeModuleDir, 'package.json'),
      JSON.stringify({ name: 'traced-config', type: 'module', exports: './index.js' }),
      'utf-8',
    );
    writeFileSync(
      join(fakeModuleDir, 'index.js'),
      'throw new Error("malicious traced-config should not load");\n',
      'utf-8',
    );

    try {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      const traceEntries = loadTraceEntriesViaRuntime({
        provider: {
          doc: 'provider',
          format: String,
          env: 'TAKT_PROVIDER',
          sources: { global: false, local: true, env: true, cli: false },
        },
      }, 'local', { provider: 'codex' });

      expect(traceEntries.get('provider')?.origin).toBe('local');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Given TMPDIR points to a missing directory, When runtime bridge loads trace entries, Then mkdtemp succeeds', () => {
    const originalTmpDir = process.env.TMPDIR;
    const tempDir = join(tmpdir(), `takt-traced-missing-tmpdir-${randomUUID()}`);
    const missingTmpDir = join(tempDir, 'missing-tmp');
    mkdirSync(tempDir, { recursive: true });
    process.env.TMPDIR = missingTmpDir;

    try {
      const traceEntries = loadTraceEntriesViaRuntime({
        provider: {
          doc: 'provider',
          format: String,
          env: 'TAKT_PROVIDER',
          sources: { global: false, local: true, env: true, cli: false },
        },
      }, 'local', { provider: 'codex' });

      expect(traceEntries.get('provider')?.origin).toBe('local');
      expect(traceEntries.get('provider')?.value).toBe('codex');
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runtime bridge rejects an invalid helper timeout before spawning the helper', () => {
    process.env.TAKT_TRACED_CONFIG_HELPER_TIMEOUT_MS = '0';

    expect(() => loadTraceEntriesViaRuntime({
      provider: {
        doc: 'provider',
        format: String,
        env: 'TAKT_PROVIDER',
        sources: { global: false, local: true, env: true, cli: false },
      },
    }, 'local', { provider: 'codex' }))
      .toThrow('TAKT_TRACED_CONFIG_HELPER_TIMEOUT_MS must be a positive integer number of milliseconds');
  });

  it('runtime bridge times out a slow helper startup instead of blocking workflow progress', () => {
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const tempDir = join(tmpdir(), `takt-traced-slow-helper-${randomUUID()}`);
    const slowImportPath = join(tempDir, 'slow-import.mjs');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(slowImportPath, 'await new Promise((resolve) => setTimeout(resolve, 250));\n', 'utf-8');
    process.env.NODE_OPTIONS = `--import=${slowImportPath}`;
    process.env.TAKT_TRACED_CONFIG_HELPER_TIMEOUT_MS = '25';

    try {
      expect(() => loadTraceEntriesViaRuntime({
        provider: {
          doc: 'provider',
          format: String,
          env: 'TAKT_PROVIDER',
          sources: { global: false, local: true, env: true, cli: false },
        },
      }, 'local', { provider: 'codex' }))
        .toThrow('traced-config helper timed out after 25ms');
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
