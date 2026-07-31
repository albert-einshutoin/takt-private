/**
 * Persona configuration loader
 *
 * Loads persona prompts with user → builtin fallback:
 * 1. User personas: ~/.takt/personas/*.md
 * 2. Builtin personas: builtins/{lang}/facets/personas/*.md
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { CustomAgentConfig } from '../../../core/models/index.js';
import {
  getGlobalConfigDir,
  getProjectConfigDir,
  getGlobalPersonasDir,
  getBuiltinPersonasDir,
  getGlobalFacetDir,
  getProjectFacetDir,
  getRepertoireDir,
  isPathSafe,
} from '../paths.js';
import { resolveConfigValue } from '../resolveConfigValue.js';
import { withImmediateRepertoireReadPermit } from '../../../features/repertoire/read-permit.js';
import { createInternalWorkflowReadContext } from './workflowDiscovery.js';
import { createRepertoireResourceReadAccess } from './repertoireResourceReadAccess.js';
import { readStableWorkflowResourceText } from './workflowResourceSafeReader.js';

/** Get all allowed base directories for persona prompt files */
function getAllowedPromptBases(cwd: string): string[] {
  const lang = resolveConfigValue(cwd, 'language') ?? 'en';
  const projectConfigDir = getProjectConfigDir(cwd);
  const globalConfigDir = getGlobalConfigDir();
  return [
    join(cwd, 'personas'),
    join(cwd, 'agents'),
    join(cwd, 'workflows'),
    join(projectConfigDir, 'personas'),
    join(projectConfigDir, 'agents'),
    join(projectConfigDir, 'workflows'),
    getProjectFacetDir(cwd, 'personas'),
    join(globalConfigDir, 'personas'),
    join(globalConfigDir, 'agents'),
    join(globalConfigDir, 'workflows'),
    join(projectConfigDir, 'repertoire'),
    getRepertoireDir(),
    getGlobalPersonasDir(),
    getBuiltinPersonasDir(lang),
    getGlobalFacetDir('personas'),
  ];
}

export function validatePersonaPromptPath(personaPath: string, cwd: string): void {
  assertAllowedPromptPath(personaPath, cwd);
  if (isRepertoirePromptPath(personaPath)) {
    readRepertoirePersonaPrompt(personaPath, false);
    return;
  }
  assertPromptExists(personaPath);
}

function assertAllowedPromptPath(personaPath: string, cwd: string): void {
  const isValid = getAllowedPromptBases(cwd).some((base) => isPathSafe(base, personaPath));
  if (!isValid) {
    throw new Error(`Persona prompt file path is not allowed: ${personaPath}`);
  }

}

function assertPromptExists(personaPath: string): void {
  if (!existsSync(personaPath)) throw new Error(`Persona prompt file not found: ${personaPath}`);
}

function isRepertoirePromptPath(personaPath: string): boolean {
  const candidate = relative(getRepertoireDir(), personaPath);
  return candidate !== '' && !candidate.startsWith('..') && !isAbsolute(candidate);
}

function readRepertoirePersonaPrompt(personaPath: string, returnText: boolean): string {
  const globalConfigDir = getGlobalConfigDir();
  return withImmediateRepertoireReadPermit({
    globalConfigDir,
    operation: (permit) => {
      const access = createRepertoireResourceReadAccess(
        createInternalWorkflowReadContext(globalConfigDir, permit),
      );
      if (!access.exists(personaPath)) throw new Error(`Persona prompt file not found: ${personaPath}`);
      return returnText ? access.readText(personaPath) : '';
    },
  });
}

/** Load agents from markdown files in a directory */
export function loadAgentsFromDir(dirPath: string): CustomAgentConfig[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const agents: CustomAgentConfig[] = [];
  for (const file of readdirSync(dirPath)) {
    if (file.endsWith('.md')) {
      const name = basename(file, '.md');
      const promptFile = join(dirPath, file);
      agents.push({
        name,
        promptFile,
      });
    }
  }
  return agents;
}

/** Load all custom agents from ~/.takt/personas/ */
export function loadCustomAgents(): Map<string, CustomAgentConfig> {
  const agents = new Map<string, CustomAgentConfig>();
  for (const agent of loadAgentsFromDir(getGlobalPersonasDir())) {
    agents.set(agent.name, agent);
  }
  return agents;
}

/** List available custom agents */
export function listCustomAgents(): string[] {
  return Array.from(loadCustomAgents().keys()).sort();
}

/** Load agent prompt content. */
export function loadAgentPrompt(agent: CustomAgentConfig, cwd: string): string {
  if (agent.prompt) {
    return agent.prompt;
  }

  if (agent.promptFile) {
    const promptFile = agent.promptFile;
    assertAllowedPromptPath(promptFile, cwd);

    if (isRepertoirePromptPath(promptFile)) return readRepertoirePersonaPrompt(promptFile, true);

    assertPromptExists(promptFile);

    return readStableWorkflowResourceText(agent.promptFile);
  }

  throw new Error(`Agent ${agent.name} has no prompt defined`);
}

/** Load persona prompt from a resolved path. */
export function loadPersonaPromptFromPath(personaPath: string, cwd: string): string {
  assertAllowedPromptPath(personaPath, cwd);
  if (isRepertoirePromptPath(personaPath)) return readRepertoirePersonaPrompt(personaPath, true);
  assertPromptExists(personaPath);
  return readStableWorkflowResourceText(personaPath);
}
