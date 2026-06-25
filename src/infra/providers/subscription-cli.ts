import { callSubscriptionCli, type SubscriptionCliProviderType } from '../subscription-cli/client.js';
import { resolveCodexCliPath, resolveCursorCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

function resolveCommandPath(provider: SubscriptionCliProviderType): string | undefined {
  if (provider === 'codex-cli') {
    return resolveCodexCliPath();
  }
  if (provider === 'cursor-cli') {
    return resolveCursorCliPath();
  }
  return undefined;
}

/** CLI-only provider for subscription/login based agent CLIs. */
export class SubscriptionCliProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = false;

  constructor(readonly providerType: SubscriptionCliProviderType) {}

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callSubscriptionCli(name, prompt, {
          provider: this.providerType,
          cwd: options.cwd,
          abortSignal: options.abortSignal,
          sessionId: options.sessionId,
          model: options.model,
          systemPrompt,
          permissionMode: options.permissionMode,
          commandPath: resolveCommandPath(this.providerType),
          onStream: options.onStream,
          childProcessEnv: options.childProcessEnv,
        });
      },
    };
  }
}
