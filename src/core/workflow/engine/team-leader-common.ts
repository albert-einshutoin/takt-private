import type {
  PartDefinition,
  PartResult,
  StepProviderOptions,
  WorkflowStep,
} from '../../models/types.js';
import { formatAgentFailure } from '../../../shared/types/agent-failure.js';
import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';

interface ProviderOptionFields {
  providerOptions?: StepProviderOptions;
  directProviderOptions?: StepProviderOptions;
  workflowProviderOptions?: StepProviderOptions;
}

export function summarizeParts(parts: PartDefinition[]): Array<{ id: string; title: string }> {
  return parts.map((part) => ({ id: part.id, title: part.title }));
}

export function resolvePartErrorDetail(partResult: PartResult): string {
  const detail = partResult.response.error ?? partResult.response.content;
  if (!detail) {
    throw new Error(`Part "${partResult.part.id}" failed without error detail`);
  }
  if (partResult.response.failureCategory) {
    return formatAgentFailure({
      category: partResult.response.failureCategory,
      reason: detail,
    }, { includeCategoryPrefix: true });
  }
  return detail;
}

function resolveProviderOptionFields(
  step: WorkflowStep,
  scopedOptions: StepProviderOptions | undefined,
): ProviderOptionFields {
  const workflowProviderOptions = 'workflowProviderOptions' in step
    ? step.workflowProviderOptions
    : undefined;
  const baseDirectProviderOptions = 'directProviderOptions' in step
    ? step.directProviderOptions
    : 'workflowProviderOptions' in step
      ? undefined
      : step.providerOptions;
  const directProviderOptions = mergeProviderOptions(
    baseDirectProviderOptions,
    scopedOptions,
  );
  const providerOptions = mergeProviderOptions(workflowProviderOptions, directProviderOptions);

  return {
    providerOptions,
    ...(directProviderOptions !== undefined || 'directProviderOptions' in step || workflowProviderOptions !== undefined
      ? { directProviderOptions }
      : {}),
    ...(workflowProviderOptions !== undefined || 'workflowProviderOptions' in step
      ? { workflowProviderOptions }
      : {}),
  };
}

export function createPartStep(step: WorkflowStep, part: PartDefinition): WorkflowStep {
  if (!step.teamLeader) {
    throw new Error(`Step "${step.name}" has no teamLeader configuration`);
  }

  const partPersona = step.teamLeader.partPersona ?? step.persona;
  const partPersonaPath = step.teamLeader.partPersonaPath ?? step.personaPath;
  const partPersonaDisplayName = partPersona ?? step.personaDisplayName ?? `${step.name}:${part.id}`;
  const providerRoutingPersonaKey = step.teamLeader.partPersona
    ? step.teamLeader.partPersona
    : step.providerRoutingPersonaKey;
  const providerOptionFields = resolveProviderOptionFields(step, step.teamLeader.partProviderOptions);

  return {
    name: `${step.name}.${part.id}`,
    description: part.title,
    persona: partPersona,
    personaPath: partPersonaPath,
    personaDisplayName: partPersonaDisplayName,
    providerRoutingPersonaKey,
    tags: step.teamLeader.partTags ?? step.tags,
    session: 'refresh',
    ...providerOptionFields,
    mcpServers: step.mcpServers,
    provider: step.provider,
    providerSpecified: step.providerSpecified,
    model: step.model,
    modelSpecified: step.modelSpecified,
    requiredPermissionMode: step.teamLeader.partPermissionMode ?? step.requiredPermissionMode,
    edit: step.teamLeader.partEdit ?? step.edit,
    allowGitCommit: step.allowGitCommit,
    instruction: part.instruction,
    passPreviousResponse: false,
  };
}

export function createTeamLeaderPlanningStep(step: WorkflowStep): WorkflowStep {
  if (!step.teamLeader) {
    throw new Error(`Step "${step.name}" has no teamLeader configuration`);
  }

  return {
    ...step,
    ...resolveProviderOptionFields(step, step.teamLeader.providerOptions),
    persona: step.teamLeader.persona ?? step.persona,
    personaPath: step.teamLeader.personaPath ?? step.personaPath,
    personaDisplayName: step.teamLeader.personaDisplayName ?? step.personaDisplayName,
    providerRoutingPersonaKey: step.teamLeader.providerRoutingPersonaKey ?? step.providerRoutingPersonaKey,
  };
}
