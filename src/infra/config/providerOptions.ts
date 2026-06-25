import type {
  ClaudeEffort,
  ClaudeTerminalProviderOptions,
  CodexReasoningEffort,
  CopilotEffort,
  WorkflowStep,
  StepProviderOptions,
} from '../../core/models/workflow-types.js';
import type { PersonaProviderEntry, ProviderRoutingConfig } from '../../core/models/config-types.js';
import type {
  ProviderOptionsOriginResolver,
  ProviderOptionsSource,
  ProviderOptionsTraceOrigin,
  ProviderResolutionSource,
} from '../../core/workflow/provider-options-trace.js';
import { isProviderType, type ProviderType } from '../../shared/types/provider.js';
import { providerSupportsClaudeAllowedTools } from '../providers/provider-capabilities.js';

type RawGroundCheckOptions = {
  enabled?: boolean;
  provider?: string;
  model?: string;
  provider_options?: RawProviderOptions | Record<string, unknown>;
};

type RawProviderOptions = {
  extends?: string;
  codex?: {
    base_url?: string;
    network_access?: boolean;
    reasoning_effort?: CodexReasoningEffort;
    ground_check?: RawGroundCheckOptions;
  };
  opencode?: {
    network_access?: boolean;
    variant?: string;
    allowed_tools?: string[];
    ground_check?: RawGroundCheckOptions;
  };
  claude?: {
    base_url?: string;
    allowed_tools?: string[];
    effort?: ClaudeEffort;
    sandbox?: {
      allow_unsandboxed_commands?: boolean;
      excluded_commands?: string[];
    };
    ground_check?: RawGroundCheckOptions;
  };
  claude_terminal?: {
    backend?: ClaudeTerminalProviderOptions['backend'];
    timeout_ms?: number;
    keep_session?: boolean;
    transcript_poll_interval_ms?: number;
    ground_check?: RawGroundCheckOptions;
  };
  copilot?: {
    effort?: CopilotEffort;
    ground_check?: RawGroundCheckOptions;
  };
  cursor?: {
    use_prompt_file?: boolean;
    ground_check?: RawGroundCheckOptions;
  };
  kiro?: {
    agent?: string;
    ground_check?: RawGroundCheckOptions;
  };
  agy?: {
    print_timeout?: string;
    ground_check?: RawGroundCheckOptions;
  };
};

type ProviderBaseUrlTrust = 'trusted' | 'loopback-only' | 'local-loopback-only';

export interface NormalizeProviderOptionsOptions {
  baseUrlTrust?: ProviderBaseUrlTrust;
  pathPrefix?: string;
  getOrigin?: (path: string) => ProviderOptionsTraceOrigin;
}

export interface ProviderOptionsLayer {
  source: ProviderResolutionSource;
  options: StepProviderOptions | undefined;
}

interface StepProviderOptionsLayerContext {
  providerRouting: ProviderRoutingConfig | undefined;
  personaProviders: Record<string, PersonaProviderEntry> | undefined;
}

function isLoopbackBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || hostname === '[::1]'
    || isIpv4LoopbackHost(hostname);
}

function isIpv4LoopbackHost(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function shouldRequireLoopbackBaseUrl(
  path: string,
  options: NormalizeProviderOptionsOptions,
): boolean {
  const trust = options.baseUrlTrust ?? 'trusted';
  if (trust === 'trusted') {
    return false;
  }
  if (trust === 'loopback-only') {
    return true;
  }

  const origin = options.getOrigin?.(path) ?? 'default';
  return origin === 'local' || origin === 'default';
}

function assertAllowedProviderBaseUrl(
  path: string,
  value: string | undefined,
  options: NormalizeProviderOptionsOptions,
): void {
  if (value === undefined || !shouldRequireLoopbackBaseUrl(path, options)) {
    return;
  }
  if (isLoopbackBaseUrl(value)) {
    return;
  }

  throw new Error(
    `Configuration error: ${path} must use a loopback base_url when defined by workflow or project config. `
    + 'Move non-loopback provider base URLs to global config or TAKT_PROVIDER_OPTIONS_*_BASE_URL.',
  );
}

function normalizeGroundCheckOptions(
  raw: RawGroundCheckOptions | undefined,
  path: string,
  normalizationOptions: NormalizeProviderOptionsOptions,
): NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  if (raw.provider !== undefined && !isProviderType(raw.provider)) {
    throw new Error(`Configuration error: ${path}.provider must be a supported provider.`);
  }

  const providerOptions = normalizeProviderOptions(
    raw.provider_options,
    {
      ...normalizationOptions,
      pathPrefix: `${path}.provider_options`,
    },
  );
  const result: NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']> = {
    ...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
    ...(raw.provider !== undefined ? { provider: raw.provider } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Convert raw YAML provider_options (snake_case) to internal format (camelCase). */
export function normalizeProviderOptions(
  raw: RawProviderOptions | Record<string, unknown> | undefined,
  normalizationOptions: NormalizeProviderOptionsOptions = {},
): StepProviderOptions | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const options = raw as RawProviderOptions;
  if (options.extends !== undefined) {
    throw new Error('Configuration error: provider_options.extends must be resolved before provider options normalization.');
  }

  const result: StepProviderOptions = {};
  if (
    options.codex?.base_url !== undefined
    || options.codex?.network_access !== undefined
    || options.codex?.reasoning_effort !== undefined
    || options.codex?.ground_check !== undefined
  ) {
    const codexBaseUrlPath = `${normalizationOptions.pathPrefix ?? 'provider_options'}.codex.base_url`;
    assertAllowedProviderBaseUrl(codexBaseUrlPath, options.codex.base_url, normalizationOptions);
    const groundCheck = normalizeGroundCheckOptions(
      options.codex.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.codex.ground_check`,
      normalizationOptions,
    );
    result.codex = {
      ...(options.codex.base_url !== undefined
        ? { baseUrl: options.codex.base_url }
        : {}),
      ...(options.codex.network_access !== undefined
        ? { networkAccess: options.codex.network_access }
        : {}),
      ...(options.codex.reasoning_effort !== undefined
        ? { reasoningEffort: options.codex.reasoning_effort }
        : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  if (
    options.opencode?.network_access !== undefined
    || options.opencode?.variant !== undefined
    || options.opencode?.allowed_tools !== undefined
    || options.opencode?.ground_check !== undefined
  ) {
    const groundCheck = normalizeGroundCheckOptions(
      options.opencode.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.opencode.ground_check`,
      normalizationOptions,
    );
    result.opencode = {
      ...(options.opencode.network_access !== undefined
        ? { networkAccess: options.opencode.network_access }
        : {}),
      ...(options.opencode.variant !== undefined
        ? { variant: options.opencode.variant }
        : {}),
      ...(options.opencode.allowed_tools !== undefined
        ? { allowedTools: options.opencode.allowed_tools }
        : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  if (
    options.claude?.base_url !== undefined
    || options.claude?.allowed_tools !== undefined
    || options.claude?.effort !== undefined
    || options.claude?.sandbox
    || options.claude?.ground_check !== undefined
  ) {
    const claude: NonNullable<StepProviderOptions['claude']> = {};
    if (options.claude.base_url !== undefined) {
      const claudeBaseUrlPath = `${normalizationOptions.pathPrefix ?? 'provider_options'}.claude.base_url`;
      assertAllowedProviderBaseUrl(claudeBaseUrlPath, options.claude.base_url, normalizationOptions);
      claude.baseUrl = options.claude.base_url;
    }
    if (options.claude.allowed_tools !== undefined) {
      claude.allowedTools = options.claude.allowed_tools;
    }
    if (options.claude.effort !== undefined) {
      claude.effort = options.claude.effort;
    }
    if (options.claude.sandbox) {
      const sandbox = {
        ...(options.claude.sandbox.allow_unsandboxed_commands !== undefined
          ? { allowUnsandboxedCommands: options.claude.sandbox.allow_unsandboxed_commands }
          : {}),
        ...(options.claude.sandbox.excluded_commands !== undefined
          ? { excludedCommands: options.claude.sandbox.excluded_commands }
          : {}),
      };
      if (Object.keys(sandbox).length > 0) {
        claude.sandbox = sandbox;
      }
    }
    const groundCheck = normalizeGroundCheckOptions(
      options.claude.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.claude.ground_check`,
      normalizationOptions,
    );
    if (groundCheck !== undefined) {
      claude.groundCheck = groundCheck;
    }
    if (Object.keys(claude).length > 0) {
      result.claude = claude;
    }
  }
  if (options.copilot?.effort !== undefined || options.copilot?.ground_check !== undefined) {
    const groundCheck = normalizeGroundCheckOptions(
      options.copilot.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.copilot.ground_check`,
      normalizationOptions,
    );
    result.copilot = {
      ...(options.copilot.effort !== undefined ? { effort: options.copilot.effort } : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  if (options.cursor?.use_prompt_file !== undefined || options.cursor?.ground_check !== undefined) {
    const groundCheck = normalizeGroundCheckOptions(
      options.cursor.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.cursor.ground_check`,
      normalizationOptions,
    );
    result.cursor = {
      ...(options.cursor.use_prompt_file !== undefined ? { usePromptFile: options.cursor.use_prompt_file } : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  if (options.kiro?.agent !== undefined || options.kiro?.ground_check !== undefined) {
    const groundCheck = normalizeGroundCheckOptions(
      options.kiro.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.kiro.ground_check`,
      normalizationOptions,
    );
    result.kiro = {
      ...(options.kiro.agent !== undefined ? { agent: options.kiro.agent } : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  if (options.agy?.print_timeout !== undefined || options.agy?.ground_check !== undefined) {
    const groundCheck = normalizeGroundCheckOptions(
      options.agy.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.agy.ground_check`,
      normalizationOptions,
    );
    result.agy = {
      ...(options.agy.print_timeout !== undefined ? { printTimeout: options.agy.print_timeout } : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  if (
    options.claude_terminal?.backend !== undefined
    || options.claude_terminal?.timeout_ms !== undefined
    || options.claude_terminal?.keep_session !== undefined
    || options.claude_terminal?.transcript_poll_interval_ms !== undefined
    || options.claude_terminal?.ground_check !== undefined
  ) {
    const groundCheck = normalizeGroundCheckOptions(
      options.claude_terminal.ground_check,
      `${normalizationOptions.pathPrefix ?? 'provider_options'}.claude_terminal.ground_check`,
      normalizationOptions,
    );
    result.claudeTerminal = {
      ...(options.claude_terminal.backend !== undefined
        ? { backend: options.claude_terminal.backend }
        : {}),
      ...(options.claude_terminal.timeout_ms !== undefined
        ? { timeoutMs: options.claude_terminal.timeout_ms }
        : {}),
      ...(options.claude_terminal.keep_session !== undefined
        ? { keepSession: options.claude_terminal.keep_session }
        : {}),
      ...(options.claude_terminal.transcript_poll_interval_ms !== undefined
        ? { transcriptPollIntervalMs: options.claude_terminal.transcript_poll_interval_ms }
        : {}),
      ...(groundCheck !== undefined ? { groundCheck } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeGroundCheckOptions(
  ...layers: (NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']> | undefined)[]
): NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']> | undefined {
  const result: NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']> = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.enabled !== undefined) {
      result.enabled = layer.enabled;
    }
    if (layer.provider !== undefined) {
      result.provider = layer.provider;
    }
    if (layer.model !== undefined) {
      result.model = layer.model;
    }
    if (layer.providerOptions !== undefined) {
      result.providerOptions = mergeProviderOptions(result.providerOptions, layer.providerOptions);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Deep merge provider options. Later sources override earlier ones. */
export function mergeProviderOptions(
  ...layers: (StepProviderOptions | undefined)[]
): StepProviderOptions | undefined {
  const result: StepProviderOptions = {};

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.codex) {
      const groundCheck = mergeGroundCheckOptions(result.codex?.groundCheck, layer.codex.groundCheck);
      result.codex = {
        ...result.codex,
        ...(layer.codex.baseUrl !== undefined
          ? { baseUrl: layer.codex.baseUrl }
          : {}),
        ...(layer.codex.networkAccess !== undefined
          ? { networkAccess: layer.codex.networkAccess }
          : {}),
        ...(layer.codex.reasoningEffort !== undefined
          ? { reasoningEffort: layer.codex.reasoningEffort }
          : {}),
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.opencode) {
      const groundCheck = mergeGroundCheckOptions(result.opencode?.groundCheck, layer.opencode.groundCheck);
      result.opencode = {
        ...result.opencode,
        ...layer.opencode,
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.claude) {
      const groundCheck = mergeGroundCheckOptions(result.claude?.groundCheck, layer.claude.groundCheck);
      result.claude = {
        ...result.claude,
        ...(layer.claude.baseUrl !== undefined
          ? { baseUrl: layer.claude.baseUrl }
          : {}),
        ...(layer.claude.allowedTools !== undefined
          ? { allowedTools: layer.claude.allowedTools }
          : {}),
        ...(layer.claude.effort !== undefined
          ? { effort: layer.claude.effort }
          : {}),
        ...(layer.claude.sandbox
          ? { sandbox: { ...result.claude?.sandbox, ...layer.claude.sandbox } }
          : {}),
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.copilot) {
      const groundCheck = mergeGroundCheckOptions(result.copilot?.groundCheck, layer.copilot.groundCheck);
      result.copilot = {
        ...result.copilot,
        ...(layer.copilot.effort !== undefined
          ? { effort: layer.copilot.effort }
          : {}),
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.cursor) {
      const groundCheck = mergeGroundCheckOptions(result.cursor?.groundCheck, layer.cursor.groundCheck);
      result.cursor = {
        ...result.cursor,
        ...(layer.cursor.usePromptFile !== undefined
          ? { usePromptFile: layer.cursor.usePromptFile }
          : {}),
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.kiro) {
      const groundCheck = mergeGroundCheckOptions(result.kiro?.groundCheck, layer.kiro.groundCheck);
      result.kiro = {
        ...result.kiro,
        ...(layer.kiro.agent !== undefined
          ? { agent: layer.kiro.agent }
          : {}),
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.agy) {
      const groundCheck = mergeGroundCheckOptions(result.agy?.groundCheck, layer.agy.groundCheck);
      result.agy = {
        ...result.agy,
        ...(layer.agy.printTimeout !== undefined
          ? { printTimeout: layer.agy.printTimeout }
          : {}),
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
    if (layer.claudeTerminal) {
      const groundCheck = mergeGroundCheckOptions(result.claudeTerminal?.groundCheck, layer.claudeTerminal.groundCheck);
      result.claudeTerminal = {
        ...result.claudeTerminal,
        ...layer.claudeTerminal,
        ...(groundCheck !== undefined ? { groundCheck } : {}),
      };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveFallbackOrigin(
  source: ProviderOptionsSource | undefined,
): ProviderOptionsTraceOrigin {
  if (source === 'project') return 'local';
  if (source === 'global') return 'global';
  if (source === 'env') return 'env';
  return 'default';
}

export function resolveProviderOptionOrigin(
  resolver: ProviderOptionsOriginResolver | undefined,
  path: string,
  fallbackSource: ProviderOptionsSource | undefined,
): ProviderOptionsTraceOrigin {
  if (!resolver) {
    return resolveFallbackOrigin(fallbackSource);
  }

  let current = path;
  while (current.length > 0) {
    const origin = resolver(current);
    if (origin !== 'default') {
      return origin;
    }
    const lastDot = current.lastIndexOf('.');
    if (lastDot < 0) {
      break;
    }
    current = current.slice(0, lastDot);
  }

  return resolver('');
}

function selectProviderValue<T>(
  configValue: T | undefined,
  personaValue: T | undefined,
  stepValue: T | undefined,
  origin: ProviderOptionsTraceOrigin,
): T | undefined {
  if ((origin === 'env' || origin === 'cli') && configValue !== undefined) {
    return configValue;
  }
  return stepValue ?? personaValue ?? configValue;
}

/**
 * Select by scope only for leaves whose explicit file or workflow value must
 * remain above TAKT env/CLI config origins.
 */
function selectProviderValueByScope<T>(
  configValue: T | undefined,
  personaValue: T | undefined,
  stepValue: T | undefined,
): T | undefined {
  return stepValue ?? personaValue ?? configValue;
}

type GroundCheckOptions = NonNullable<NonNullable<StepProviderOptions['opencode']>['groundCheck']>;

function selectGroundCheckValue<T>(
  configValue: T | undefined,
  personaValue: T | undefined,
  stepValue: T | undefined,
  path: string,
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
): T | undefined {
  return selectProviderValue(
    configValue,
    personaValue,
    stepValue,
    resolveProviderOptionOrigin(originResolver, path, source),
  );
}

function resolveEffectiveGroundCheckOptions(
  pathPrefix: string,
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configOptions: GroundCheckOptions | undefined,
  personaOptions: GroundCheckOptions | undefined,
  stepOptions: GroundCheckOptions | undefined,
): GroundCheckOptions | undefined {
  const enabled = selectGroundCheckValue(
    configOptions?.enabled,
    personaOptions?.enabled,
    stepOptions?.enabled,
    `${pathPrefix}.groundCheck.enabled`,
    source,
    originResolver,
  );
  const provider = selectGroundCheckValue(
    configOptions?.provider,
    personaOptions?.provider,
    stepOptions?.provider,
    `${pathPrefix}.groundCheck.provider`,
    source,
    originResolver,
  );
  const model = selectGroundCheckValue(
    configOptions?.model,
    personaOptions?.model,
    stepOptions?.model,
    `${pathPrefix}.groundCheck.model`,
    source,
    originResolver,
  );
  const providerOptions = mergeProviderOptions(
    configOptions?.providerOptions,
    personaOptions?.providerOptions,
    stepOptions?.providerOptions,
  );

  const result: GroundCheckOptions = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolvePersonaProviderOptions(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
  personaDisplayName: string | undefined,
): StepProviderOptions | undefined {
  if (!personaDisplayName) {
    return undefined;
  }
  return personaProviders?.[personaDisplayName]?.providerOptions;
}

export function resolveDirectStepProviderOptions(step: WorkflowStep): StepProviderOptions | undefined {
  if ('directProviderOptions' in step) {
    return step.directProviderOptions;
  }
  return step.providerOptions;
}

export function resolveStepWorkflowProviderOptions(step: WorkflowStep): StepProviderOptions | undefined {
  if ('workflowProviderOptions' in step) {
    return step.workflowProviderOptions;
  }
  return undefined;
}

export function resolveStepProviderOptionsLayers(
  step: WorkflowStep,
  context: StepProviderOptionsLayerContext,
): ProviderOptionsLayer[] {
  const layers: ProviderOptionsLayer[] = [
    {
      source: 'workflow',
      options: resolveStepWorkflowProviderOptions(step),
    },
    {
      source: 'persona_providers',
      options: resolvePersonaProviderOptions(context.personaProviders, step.personaDisplayName),
    },
  ];

  if (step.providerRoutingPersonaKey) {
    layers.push({
      source: 'provider_routing.personas',
      options: context.providerRouting?.personas?.[step.providerRoutingPersonaKey]?.providerOptions,
    });
  }
  for (const tag of step.tags ?? []) {
    layers.push({
      source: 'provider_routing.tags',
      options: context.providerRouting?.tags?.[tag]?.providerOptions,
    });
  }
  layers.push({
    source: 'provider_routing.steps',
    options: context.providerRouting?.steps?.[step.name]?.providerOptions,
  });

  return layers.filter((layer) => layer.options !== undefined);
}

export function mergeStepProviderOptionsLayers(
  step: WorkflowStep,
  context: StepProviderOptionsLayerContext,
): StepProviderOptions | undefined {
  return mergeProviderOptions(
    ...resolveStepProviderOptionsLayers(step, context).map((layer) => layer.options),
  );
}

export function resolveEffectiveProviderOptions(
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  resolvedConfigOptions: StepProviderOptions | undefined,
  stepOptions: StepProviderOptions | undefined,
  personaOptions?: StepProviderOptions,
): StepProviderOptions | undefined {
  if (!resolvedConfigOptions) {
    return mergeProviderOptions(personaOptions, stepOptions);
  }
  if (!personaOptions && !stepOptions) {
    return resolvedConfigOptions;
  }

  const claudeSandbox = {
    allowUnsandboxedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.allowUnsandboxedCommands,
      personaOptions?.claude?.sandbox?.allowUnsandboxedCommands,
      stepOptions?.claude?.sandbox?.allowUnsandboxedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.allowUnsandboxedCommands', source),
    ),
    excludedCommands: selectProviderValue(
      resolvedConfigOptions.claude?.sandbox?.excludedCommands,
      personaOptions?.claude?.sandbox?.excludedCommands,
      stepOptions?.claude?.sandbox?.excludedCommands,
      resolveProviderOptionOrigin(originResolver, 'claude.sandbox.excludedCommands', source),
    ),
  };

  const claude = {
    sandbox: claudeSandbox.allowUnsandboxedCommands !== undefined || claudeSandbox.excludedCommands !== undefined
      ? claudeSandbox
      : undefined,
    allowedTools: selectProviderValue(
      resolvedConfigOptions.claude?.allowedTools,
      personaOptions?.claude?.allowedTools,
      stepOptions?.claude?.allowedTools,
      resolveProviderOptionOrigin(originResolver, 'claude.allowedTools', source),
    ),
    baseUrl: selectProviderValueByScope(
      resolvedConfigOptions.claude?.baseUrl,
      personaOptions?.claude?.baseUrl,
      stepOptions?.claude?.baseUrl,
    ),
    effort: selectProviderValue(
      resolvedConfigOptions.claude?.effort,
      personaOptions?.claude?.effort,
      stepOptions?.claude?.effort,
      resolveProviderOptionOrigin(originResolver, 'claude.effort', source),
    ),
  };

  const codexNetworkAccess = selectProviderValue(
    resolvedConfigOptions.codex?.networkAccess,
    personaOptions?.codex?.networkAccess,
    stepOptions?.codex?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'codex.networkAccess', source),
  );
  const codexReasoningEffort = selectProviderValue(
    resolvedConfigOptions.codex?.reasoningEffort,
    personaOptions?.codex?.reasoningEffort,
    stepOptions?.codex?.reasoningEffort,
    resolveProviderOptionOrigin(originResolver, 'codex.reasoningEffort', source),
  );
  const codexBaseUrl = selectProviderValueByScope(
    resolvedConfigOptions.codex?.baseUrl,
    personaOptions?.codex?.baseUrl,
    stepOptions?.codex?.baseUrl,
  );
  const opencodeNetworkAccess = selectProviderValue(
    resolvedConfigOptions.opencode?.networkAccess,
    personaOptions?.opencode?.networkAccess,
    stepOptions?.opencode?.networkAccess,
    resolveProviderOptionOrigin(originResolver, 'opencode.networkAccess', source),
  );
  const opencodeVariant = selectProviderValue(
    resolvedConfigOptions.opencode?.variant,
    personaOptions?.opencode?.variant,
    stepOptions?.opencode?.variant,
    resolveProviderOptionOrigin(originResolver, 'opencode.variant', source),
  );
  const opencodeAllowedTools = selectProviderValue(
    resolvedConfigOptions.opencode?.allowedTools,
    personaOptions?.opencode?.allowedTools,
    stepOptions?.opencode?.allowedTools,
    resolveProviderOptionOrigin(originResolver, 'opencode.allowedTools', source),
  );
  const copilotEffort = selectProviderValue(
    resolvedConfigOptions.copilot?.effort,
    personaOptions?.copilot?.effort,
    stepOptions?.copilot?.effort,
    resolveProviderOptionOrigin(originResolver, 'copilot.effort', source),
  );
  const cursorUsePromptFile = selectProviderValue(
    resolvedConfigOptions.cursor?.usePromptFile,
    personaOptions?.cursor?.usePromptFile,
    stepOptions?.cursor?.usePromptFile,
    resolveProviderOptionOrigin(originResolver, 'cursor.usePromptFile', source),
  );
  const kiroAgent = selectProviderValue(
    resolvedConfigOptions.kiro?.agent,
    personaOptions?.kiro?.agent,
    stepOptions?.kiro?.agent,
    resolveProviderOptionOrigin(originResolver, 'kiro.agent', source),
  );
  const agyPrintTimeout = selectProviderValue(
    resolvedConfigOptions.agy?.printTimeout,
    personaOptions?.agy?.printTimeout,
    stepOptions?.agy?.printTimeout,
    resolveProviderOptionOrigin(originResolver, 'agy.printTimeout', source),
  );
  const claudeTerminalBackend = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.backend,
    personaOptions?.claudeTerminal?.backend,
    stepOptions?.claudeTerminal?.backend,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.backend', source),
  );
  const claudeTerminalTimeoutMs = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.timeoutMs,
    personaOptions?.claudeTerminal?.timeoutMs,
    stepOptions?.claudeTerminal?.timeoutMs,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.timeoutMs', source),
  );
  const claudeTerminalKeepSession = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.keepSession,
    personaOptions?.claudeTerminal?.keepSession,
    stepOptions?.claudeTerminal?.keepSession,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.keepSession', source),
  );
  const claudeTerminalTranscriptPollIntervalMs = selectProviderValue(
    resolvedConfigOptions.claudeTerminal?.transcriptPollIntervalMs,
    personaOptions?.claudeTerminal?.transcriptPollIntervalMs,
    stepOptions?.claudeTerminal?.transcriptPollIntervalMs,
    resolveProviderOptionOrigin(originResolver, 'claudeTerminal.transcriptPollIntervalMs', source),
  );
  const codexGroundCheck = resolveEffectiveGroundCheckOptions(
    'codex',
    source,
    originResolver,
    resolvedConfigOptions.codex?.groundCheck,
    personaOptions?.codex?.groundCheck,
    stepOptions?.codex?.groundCheck,
  );
  const opencodeGroundCheck = resolveEffectiveGroundCheckOptions(
    'opencode',
    source,
    originResolver,
    resolvedConfigOptions.opencode?.groundCheck,
    personaOptions?.opencode?.groundCheck,
    stepOptions?.opencode?.groundCheck,
  );
  const claudeGroundCheck = resolveEffectiveGroundCheckOptions(
    'claude',
    source,
    originResolver,
    resolvedConfigOptions.claude?.groundCheck,
    personaOptions?.claude?.groundCheck,
    stepOptions?.claude?.groundCheck,
  );
  const copilotGroundCheck = resolveEffectiveGroundCheckOptions(
    'copilot',
    source,
    originResolver,
    resolvedConfigOptions.copilot?.groundCheck,
    personaOptions?.copilot?.groundCheck,
    stepOptions?.copilot?.groundCheck,
  );
  const cursorGroundCheck = resolveEffectiveGroundCheckOptions(
    'cursor',
    source,
    originResolver,
    resolvedConfigOptions.cursor?.groundCheck,
    personaOptions?.cursor?.groundCheck,
    stepOptions?.cursor?.groundCheck,
  );
  const kiroGroundCheck = resolveEffectiveGroundCheckOptions(
    'kiro',
    source,
    originResolver,
    resolvedConfigOptions.kiro?.groundCheck,
    personaOptions?.kiro?.groundCheck,
    stepOptions?.kiro?.groundCheck,
  );
  const agyGroundCheck = resolveEffectiveGroundCheckOptions(
    'agy',
    source,
    originResolver,
    resolvedConfigOptions.agy?.groundCheck,
    personaOptions?.agy?.groundCheck,
    stepOptions?.agy?.groundCheck,
  );
  const claudeTerminalGroundCheck = resolveEffectiveGroundCheckOptions(
    'claudeTerminal',
    source,
    originResolver,
    resolvedConfigOptions.claudeTerminal?.groundCheck,
    personaOptions?.claudeTerminal?.groundCheck,
    stepOptions?.claudeTerminal?.groundCheck,
  );

  const result: StepProviderOptions = {
    codex:
      codexBaseUrl !== undefined
      || codexNetworkAccess !== undefined
      || codexReasoningEffort !== undefined
      || codexGroundCheck !== undefined
        ? {
            ...(codexBaseUrl !== undefined ? { baseUrl: codexBaseUrl } : {}),
            ...(codexNetworkAccess !== undefined ? { networkAccess: codexNetworkAccess } : {}),
            ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
            ...(codexGroundCheck !== undefined ? { groundCheck: codexGroundCheck } : {}),
          }
        : undefined,
    opencode:
      opencodeNetworkAccess !== undefined
      || opencodeVariant !== undefined
      || opencodeAllowedTools !== undefined
      || opencodeGroundCheck !== undefined
        ? {
            ...(opencodeNetworkAccess !== undefined ? { networkAccess: opencodeNetworkAccess } : {}),
            ...(opencodeVariant !== undefined ? { variant: opencodeVariant } : {}),
            ...(opencodeAllowedTools !== undefined ? { allowedTools: opencodeAllowedTools } : {}),
            ...(opencodeGroundCheck !== undefined ? { groundCheck: opencodeGroundCheck } : {}),
          }
        : undefined,
    claude:
      claude.sandbox !== undefined
      || claude.allowedTools !== undefined
      || claude.baseUrl !== undefined
      || claude.effort !== undefined
      || claudeGroundCheck !== undefined
        ? {
            ...claude,
            ...(claudeGroundCheck !== undefined ? { groundCheck: claudeGroundCheck } : {}),
          }
        : undefined,
    copilot:
      copilotEffort !== undefined || copilotGroundCheck !== undefined
        ? {
            ...(copilotEffort !== undefined ? { effort: copilotEffort } : {}),
            ...(copilotGroundCheck !== undefined ? { groundCheck: copilotGroundCheck } : {}),
          }
        : undefined,
    cursor:
      cursorUsePromptFile !== undefined || cursorGroundCheck !== undefined
        ? {
            ...(cursorUsePromptFile !== undefined ? { usePromptFile: cursorUsePromptFile } : {}),
            ...(cursorGroundCheck !== undefined ? { groundCheck: cursorGroundCheck } : {}),
          }
        : undefined,
    kiro:
      kiroAgent !== undefined || kiroGroundCheck !== undefined
        ? {
            ...(kiroAgent !== undefined ? { agent: kiroAgent } : {}),
            ...(kiroGroundCheck !== undefined ? { groundCheck: kiroGroundCheck } : {}),
          }
        : undefined,
    agy:
      agyPrintTimeout !== undefined || agyGroundCheck !== undefined
        ? {
            ...(agyPrintTimeout !== undefined ? { printTimeout: agyPrintTimeout } : {}),
            ...(agyGroundCheck !== undefined ? { groundCheck: agyGroundCheck } : {}),
          }
        : undefined,
    claudeTerminal:
      claudeTerminalBackend !== undefined
      || claudeTerminalTimeoutMs !== undefined
      || claudeTerminalKeepSession !== undefined
      || claudeTerminalTranscriptPollIntervalMs !== undefined
      || claudeTerminalGroundCheck !== undefined
        ? {
            ...(claudeTerminalBackend !== undefined ? { backend: claudeTerminalBackend } : {}),
            ...(claudeTerminalTimeoutMs !== undefined ? { timeoutMs: claudeTerminalTimeoutMs } : {}),
            ...(claudeTerminalKeepSession !== undefined ? { keepSession: claudeTerminalKeepSession } : {}),
            ...(claudeTerminalTranscriptPollIntervalMs !== undefined
              ? { transcriptPollIntervalMs: claudeTerminalTranscriptPollIntervalMs }
              : {}),
            ...(claudeTerminalGroundCheck !== undefined ? { groundCheck: claudeTerminalGroundCheck } : {}),
          }
        : undefined,
  };

  return result.codex
    || result.opencode
    || result.claude
    || result.copilot
    || result.cursor
    || result.kiro
    || result.agy
    || result.claudeTerminal
    ? result
    : undefined;
}

function stripClaudeAllowedTools(
  providerOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const sanitizedClaude = providerOptions.claude
    ? {
        ...(providerOptions.claude.baseUrl !== undefined
          ? { baseUrl: providerOptions.claude.baseUrl }
          : {}),
        ...(providerOptions.claude.effort !== undefined
          ? { effort: providerOptions.claude.effort }
          : {}),
        ...(providerOptions.claude.sandbox !== undefined
          ? { sandbox: { ...providerOptions.claude.sandbox } }
          : {}),
        ...(providerOptions.claude.groundCheck !== undefined
          ? { groundCheck: providerOptions.claude.groundCheck }
          : {}),
      }
    : undefined;

  const sanitizedProviderOptions: StepProviderOptions = {
    ...(providerOptions.codex !== undefined
      ? { codex: { ...providerOptions.codex } }
      : {}),
    ...(providerOptions.opencode !== undefined
      ? { opencode: { ...providerOptions.opencode } }
      : {}),
    ...(sanitizedClaude !== undefined && Object.keys(sanitizedClaude).length > 0
      ? { claude: sanitizedClaude }
      : {}),
    ...(providerOptions.copilot !== undefined
      ? { copilot: { ...providerOptions.copilot } }
      : {}),
    ...(providerOptions.cursor !== undefined
      ? { cursor: { ...providerOptions.cursor } }
      : {}),
    ...(providerOptions.kiro !== undefined
      ? { kiro: { ...providerOptions.kiro } }
      : {}),
    ...(providerOptions.agy !== undefined
      ? { agy: { ...providerOptions.agy } }
      : {}),
    ...(providerOptions.claudeTerminal !== undefined
      ? { claudeTerminal: { ...providerOptions.claudeTerminal } }
      : {}),
  };

  return Object.keys(sanitizedProviderOptions).length > 0
    ? sanitizedProviderOptions
    : undefined;
}

export function resolveEffectiveTeamLeaderPartProviderOptions(
  source: ProviderOptionsSource | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  resolvedConfigOptions: StepProviderOptions | undefined,
  stepOptions: StepProviderOptions | undefined,
  resolvedProvider: ProviderType | undefined,
  partAllowedTools: string[] | undefined,
  personaOptions?: StepProviderOptions,
): StepProviderOptions | undefined {
  const mergedProviderOptions = resolveEffectiveProviderOptions(
    source,
    originResolver,
    resolvedConfigOptions,
    stepOptions,
    personaOptions,
  );

  const shouldStripClaudeTools = partAllowedTools !== undefined
    || (
      resolvedProvider !== undefined
      && providerSupportsClaudeAllowedTools(resolvedProvider) === false
    );

  return shouldStripClaudeTools
    ? stripClaudeAllowedTools(mergedProviderOptions)
    : mergedProviderOptions;
}

/** All paths we expose for per-option source attribution. */
export const PROVIDER_OPTION_PATHS = [
  'claude.baseUrl',
  'claude.effort',
  'claude.allowedTools',
  'claude.sandbox.allowUnsandboxedCommands',
  'claude.sandbox.excludedCommands',
  'claude.groundCheck.enabled',
  'claude.groundCheck.provider',
  'claude.groundCheck.model',
  'claude.groundCheck.providerOptions',
  'codex.baseUrl',
  'codex.networkAccess',
  'codex.reasoningEffort',
  'codex.groundCheck.enabled',
  'codex.groundCheck.provider',
  'codex.groundCheck.model',
  'codex.groundCheck.providerOptions',
  'opencode.networkAccess',
  'opencode.variant',
  'opencode.allowedTools',
  'opencode.groundCheck.enabled',
  'opencode.groundCheck.provider',
  'opencode.groundCheck.model',
  'opencode.groundCheck.providerOptions',
  'copilot.effort',
  'copilot.groundCheck.enabled',
  'copilot.groundCheck.provider',
  'copilot.groundCheck.model',
  'copilot.groundCheck.providerOptions',
  'cursor.usePromptFile',
  'cursor.groundCheck.enabled',
  'cursor.groundCheck.provider',
  'cursor.groundCheck.model',
  'cursor.groundCheck.providerOptions',
  'kiro.agent',
  'kiro.groundCheck.enabled',
  'kiro.groundCheck.provider',
  'kiro.groundCheck.model',
  'kiro.groundCheck.providerOptions',
  'claudeTerminal.backend',
  'claudeTerminal.timeoutMs',
  'claudeTerminal.keepSession',
  'claudeTerminal.transcriptPollIntervalMs',
  'claudeTerminal.groundCheck.enabled',
  'claudeTerminal.groundCheck.provider',
  'claudeTerminal.groundCheck.model',
  'claudeTerminal.groundCheck.providerOptions',
] as const;

export type ProviderOptionPath = (typeof PROVIDER_OPTION_PATHS)[number];

const FILE_PREFERRED_PROVIDER_OPTION_PATHS: ReadonlySet<string> = new Set([
  'claude.baseUrl',
  'codex.baseUrl',
]);

export function isFilePreferredProviderOptionPath(path: string): boolean {
  return FILE_PREFERRED_PROVIDER_OPTION_PATHS.has(path);
}

function getValueAtPath(
  options: StepProviderOptions | undefined,
  path: string,
): unknown {
  if (!options) return undefined;
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === undefined || acc === null || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as Record<string, unknown>)[part];
  }, options);
}

function originToResolutionSource(origin: ProviderOptionsTraceOrigin): ProviderResolutionSource {
  switch (origin) {
    case 'env': return 'env';
    case 'cli': return 'cli';
    case 'local': return 'project';
    case 'global': return 'global';
    case 'default': return 'default';
  }
}

/**
 * Resolve the source layer of a single provider_options path.
 */
export function resolveProviderOptionSource(
  path: string,
  stepOptions: StepProviderOptions | undefined,
  layers: ProviderOptionsLayer[],
  configOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configSource: ProviderOptionsSource | undefined,
): ProviderResolutionSource | undefined {
  const configValue = getValueAtPath(configOptions, path);
  const stepValue = getValueAtPath(stepOptions, path);
  const origin = resolveProviderOptionOrigin(originResolver, path, configSource);

  if (
    path !== 'claude.baseUrl'
    && path !== 'codex.baseUrl'
    && (origin === 'env' || origin === 'cli')
    && configValue !== undefined
  ) {
    return originToResolutionSource(origin);
  }
  if (stepValue !== undefined) return 'step';
  for (const layer of [...layers].reverse()) {
    if (getValueAtPath(layer.options, path) !== undefined) {
      return layer.source;
    }
  }
  if (configValue !== undefined) return originToResolutionSource(origin);
  return undefined;
}

/** Compute source per known provider_options path. Returns only paths with values. */
export function resolveProviderOptionsSources(
  stepOptions: StepProviderOptions | undefined,
  layers: ProviderOptionsLayer[],
  configOptions: StepProviderOptions | undefined,
  originResolver: ProviderOptionsOriginResolver | undefined,
  configSource: ProviderOptionsSource | undefined,
): Record<string, ProviderResolutionSource> {
  const result: Record<string, ProviderResolutionSource> = {};
  for (const path of PROVIDER_OPTION_PATHS) {
    const source = resolveProviderOptionSource(
      path,
      stepOptions,
      layers,
      configOptions,
      originResolver,
      configSource,
    );
    if (source !== undefined) {
      result[path] = source;
    }
  }
  return result;
}
