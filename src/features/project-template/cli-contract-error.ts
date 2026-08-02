import type { ProjectTemplateCliExitCode } from './cli-machine-contract.js';

export class ProjectTemplateCliContractError extends Error {
  readonly code: string;
  readonly exitCode: ProjectTemplateCliExitCode;

  constructor(code: string, message: string, exitCode: ProjectTemplateCliExitCode = 70) {
    super(message);
    this.name = 'ProjectTemplateCliContractError';
    this.code = code;
    this.exitCode = exitCode;
  }
}
