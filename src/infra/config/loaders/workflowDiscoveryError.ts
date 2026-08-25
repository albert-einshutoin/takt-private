export class WorkflowDiscoveryReadError extends Error {
  readonly code = 'WORKFLOW_DISCOVERY_FAILED' as const;

  constructor() {
    super('Workflow discovery failed');
    this.name = 'WorkflowDiscoveryReadError';
  }
}
