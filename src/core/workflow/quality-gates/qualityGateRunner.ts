import type { AgentResponse, QualityGate } from '../../models/types.js';
import { formatCommandGateFailure } from './commandGateMessage.js';
import { runCommandQualityGate } from './commandGateRunner.js';
import type { QualityGateResultEntry, QualityGateRunResult, RunQualityGatesOptions } from './types.js';

function createFailureResponse(content: string, persona: string): AgentResponse {
  return {
    persona,
    status: 'done',
    content,
    timestamp: new Date(),
  };
}

function gateType(gate: QualityGate): QualityGateResultEntry['gateType'] {
  return typeof gate === 'string' ? 'ai' : 'command';
}

function gateName(gate: QualityGate, index: number): string {
  if (typeof gate === 'string') {
    // String gates are prompt directives, so metrics use a stable ordinal label
    // instead of exporting potentially sensitive prompt text.
    return `ai_gate_${index + 1}`;
  }
  return gate.name ?? `command_gate_${index + 1}`;
}

export async function runQualityGates({
  qualityGates,
  projectRoot,
  step,
  childProcessEnv,
}: RunQualityGatesOptions): Promise<QualityGateRunResult> {
  if (!qualityGates || qualityGates.length === 0) {
    return { ok: true, results: [] };
  }

  const results: QualityGateResultEntry[] = [];
  for (const [index, gate] of qualityGates.entries()) {
    const name = gateName(gate, index);
    const type = gateType(gate);
    if (typeof gate === 'string') {
      results.push({ gateName: name, gateType: type, result: 'pass' });
      continue;
    }

    const result = await runCommandQualityGate({ gate, projectRoot, childProcessEnv });
    if (!result.ok) {
      results.push({ gateName: name, gateType: type, result: 'fail' });
      return {
        ok: false,
        results,
        response: createFailureResponse(
          formatCommandGateFailure(result.failure),
          step.name,
        ),
      };
    }
    results.push({ gateName: name, gateType: type, result: 'pass' });
  }

  return { ok: true, results };
}
