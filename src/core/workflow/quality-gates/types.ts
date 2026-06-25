import type { AgentResponse, CommandQualityGate, QualityGate, WorkflowStep } from '../../models/types.js';

export interface CommandQualityGateFailure {
  gateName: string;
  type: 'command';
  command: string;
  cwd: string;
  projectRoot: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
  outputLimitExceeded?: boolean;
  outputLimitBytes?: number;
  outputLogPath?: string;
  outputLogError?: string;
}

export type CommandQualityGateResult = {
  ok: true;
  stdout: string;
  stderr: string;
} | {
  ok: false;
  failure: CommandQualityGateFailure;
};

export interface RunCommandQualityGateOptions {
  gate: CommandQualityGate;
  projectRoot: string;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface QualityGateResultEntry {
  gateName: string;
  gateType: 'ai' | 'command';
  result: 'pass' | 'fail';
}

export type QualityGateRunResult = {
  ok: true;
  results?: readonly QualityGateResultEntry[];
} | {
  ok: false;
  response: AgentResponse;
  results?: readonly QualityGateResultEntry[];
};

export interface RunQualityGatesOptions {
  qualityGates: readonly QualityGate[] | undefined;
  projectRoot: string;
  step: WorkflowStep;
  childProcessEnv?: Readonly<Record<string, string>>;
}
