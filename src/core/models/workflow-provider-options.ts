import type { ProviderType } from '../../shared/types/provider.js';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

export interface GroundCheckProviderOptions {
  enabled?: boolean;
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
}

export interface CodexProviderOptions {
  baseUrl?: string;
  networkAccess?: boolean;
  reasoningEffort?: CodexReasoningEffort;
  groundCheck?: GroundCheckProviderOptions;
}

export interface OpenCodeProviderOptions {
  networkAccess?: boolean;
  variant?: string;
  allowedTools?: string[];
  groundCheck?: GroundCheckProviderOptions;
}

export const RUNTIME_PREPARE_PRESETS = ['gradle', 'node'] as const;
export type RuntimePreparePreset = (typeof RUNTIME_PREPARE_PRESETS)[number];
export const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_VALUES)[number];
export const CLAUDE_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_VALUES)[number];
export const COPILOT_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh'] as const;
export type CopilotEffort = (typeof COPILOT_EFFORT_VALUES)[number];
const RUNTIME_PREPARE_PRESET_SET: ReadonlySet<string> = new Set(RUNTIME_PREPARE_PRESETS);

export function isRuntimePreparePreset(entry: string): entry is RuntimePreparePreset {
  return RUNTIME_PREPARE_PRESET_SET.has(entry);
}

export type RuntimePrepareEntry = RuntimePreparePreset | string;

export interface WorkflowRuntimeConfig {
  prepare?: RuntimePrepareEntry[];
}

export interface ClaudeSandboxSettings {
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
}

export interface ClaudeProviderOptions {
  baseUrl?: string;
  allowedTools?: string[];
  effort?: ClaudeEffort;
  sandbox?: ClaudeSandboxSettings;
  groundCheck?: GroundCheckProviderOptions;
}

export interface ClaudeTerminalProviderOptions {
  backend?: 'tmux';
  timeoutMs?: number;
  keepSession?: boolean;
  transcriptPollIntervalMs?: number;
  groundCheck?: GroundCheckProviderOptions;
}

export interface CopilotProviderOptions {
  effort?: CopilotEffort;
  groundCheck?: GroundCheckProviderOptions;
}

export interface CursorProviderOptions {
  usePromptFile?: boolean;
  groundCheck?: GroundCheckProviderOptions;
}

export interface KiroProviderOptions {
  agent?: string;
  groundCheck?: GroundCheckProviderOptions;
}

export interface AgyProviderOptions {
  printTimeout?: string;
  groundCheck?: GroundCheckProviderOptions;
}

export interface StepProviderOptions {
  codex?: CodexProviderOptions;
  opencode?: OpenCodeProviderOptions;
  claude?: ClaudeProviderOptions;
  claudeTerminal?: ClaudeTerminalProviderOptions;
  copilot?: CopilotProviderOptions;
  cursor?: CursorProviderOptions;
  kiro?: KiroProviderOptions;
  agy?: AgyProviderOptions;
}

export type WorkflowStepKind = 'agent' | 'system' | 'workflow_call';

export interface WorkflowCallOverrides {
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
}
