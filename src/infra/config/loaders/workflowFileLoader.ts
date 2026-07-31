import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getGlobalConfigPath, getRepertoireDir } from '../paths.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { getCachedGlobalParsedConfigState } from '../global/globalConfigCore.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import { getProjectConfigPath } from '../project/projectConfigPaths.js';
import { getCachedProjectParsedConfig } from '../resolutionCache.js';
import type { FacetResolutionContext, RepertoireResourceReadAccess } from './workflowPackageScope.js';
import { normalizeWorkflowConfig } from './workflowParser.js';
import {
  resolveWorkflowArpeggioPolicy,
  resolveWorkflowCommandGatesPolicy,
  resolveWorkflowMcpServersPolicy,
  resolveWorkflowRuntimePreparePolicy,
} from './workflowNormalizationPolicies.js';
import {
  attachWorkflowSourcePath,
  attachWorkflowTrustInfo,
  attachWorkflowOpaqueRef,
  buildOpaqueWorkflowRef,
} from './workflowSourceMetadata.js';
import type { WorkflowCallArgResolutionPolicy } from './workflowCallableArgResolver.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import {
  assertNoForbiddenEffectiveSubscriptionOnlyConfigKeys,
  assertSubscriptionOnlyWorkflowConfig,
  resolveSubscriptionOnlyPolicyConfig,
} from '../../../core/subscription-only/policy.js';

interface LoadWorkflowFromFileOptions {
  trustInfo?: WorkflowTrustInfo;
  callableArgs?: Record<string, string | string[]>;
  callableArgPolicy?: WorkflowCallArgResolutionPolicy;
  repertoireReadAccess?: RepertoireResourceReadAccess;
}

type WorkflowLoadMode = 'runtime' | 'discovery';

function loadWorkflowFromFileInternal(
  filePath: string,
  projectDir: string,
  options: LoadWorkflowFromFileOptions | undefined,
  loadMode: WorkflowLoadMode,
  approvedText?: string,
): WorkflowConfig {
  if (approvedText === undefined && !existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }

  // Repertoire callers pass descriptor-approved bytes so parsing never reopens
  // a path that could have changed after its filesystem identity was checked.
  const raw = parseYaml(approvedText ?? readFileSync(filePath, 'utf-8'));
  const workflowDir = dirname(filePath);
  const context: FacetResolutionContext = {
    lang: resolveWorkflowConfigValue(projectDir, 'language'),
    projectDir,
    workflowDir,
    repertoireDir: getRepertoireDir(),
    repertoireReadAccess: options?.repertoireReadAccess,
  };

  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  const subscriptionOnlyPolicy = resolveSubscriptionOnlyPolicyConfig(globalConfig, projectConfig);
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectDir);
  const globalParsedConfig = getCachedGlobalParsedConfigState();
  const projectParsedConfig = getCachedProjectParsedConfig(projectDir);
  assertNoForbiddenEffectiveSubscriptionOnlyConfigKeys(subscriptionOnlyPolicy, [
    // Effective subscription-only may come from the other layer, so scan raw configs before schema normalization drops unknown credential leaves.
    ...(globalParsedConfig ? [{ config: globalParsedConfig, configPath: globalConfigPath }] : []),
    ...(projectParsedConfig ? [{ config: projectParsedConfig, configPath: projectConfigPath }] : []),
    { config: globalConfig, configPath: globalConfigPath },
    { config: projectConfig, configPath: projectConfigPath },
  ]);
  const trustInfo = options?.trustInfo ?? resolveWorkflowTrustInfo({
    filePath,
    projectCwd: projectDir,
  });

  const config = normalizeWorkflowConfig(
    raw,
    workflowDir,
    context,
    projectConfig.workflowOverrides,
    globalConfig.workflowOverrides,
    resolveWorkflowRuntimePreparePolicy(globalConfig.workflowRuntimePrepare, projectConfig.workflowRuntimePrepare),
    resolveWorkflowArpeggioPolicy(globalConfig.workflowArpeggio, projectConfig.workflowArpeggio),
    resolveWorkflowMcpServersPolicy(globalConfig.workflowMcpServers, projectConfig.workflowMcpServers),
    options?.callableArgs,
    options?.callableArgPolicy,
    loadMode,
    resolveWorkflowCommandGatesPolicy(globalConfig.workflowCommandGates, projectConfig.workflowCommandGates),
  );
  if (loadMode === 'runtime') {
    // Discovery must keep workflows visible so users can inspect why a workflow
    // is unavailable; runtime execution remains the enforcement point.
    assertSubscriptionOnlyWorkflowConfig(config, subscriptionOnlyPolicy);
  }
  attachWorkflowOpaqueRef(config, buildOpaqueWorkflowRef(filePath, trustInfo));
  attachWorkflowSourcePath(config, filePath);
  attachWorkflowTrustInfo(config, trustInfo);
  return config;
}

export function loadWorkflowFromFile(
  filePath: string,
  projectDir: string,
  options?: LoadWorkflowFromFileOptions,
): WorkflowConfig {
  return loadWorkflowFromFileInternal(filePath, projectDir, options, 'runtime');
}

export function loadWorkflowFromFileForDiscovery(
  filePath: string,
  projectDir: string,
  options?: LoadWorkflowFromFileOptions,
): WorkflowConfig {
  return loadWorkflowFromFileInternal(filePath, projectDir, options, 'discovery');
}

/** @internal Parses caller-approved bytes while preserving path-based trust and relative resolution. */
export function loadWorkflowFromApprovedText(
  filePath: string,
  approvedText: string,
  projectDir: string,
  options?: LoadWorkflowFromFileOptions,
): WorkflowConfig {
  return loadWorkflowFromFileInternal(filePath, projectDir, options, 'runtime', approvedText);
}

/** @internal Discovery variant of loadWorkflowFromApprovedText. */
export function loadWorkflowFromApprovedTextForDiscovery(
  filePath: string,
  approvedText: string,
  projectDir: string,
  options?: LoadWorkflowFromFileOptions,
): WorkflowConfig {
  return loadWorkflowFromFileInternal(filePath, projectDir, options, 'discovery', approvedText);
}
