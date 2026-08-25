import type {
  ProjectTemplateRepertoireDependencyInspectionPort,
} from '../src/features/project-template/repertoire-dependency-inspection-port.js';
import {
  createProjectTemplateInstalledRepertoireDependencyInspectionPort,
} from '../src/infra/repertoire/project-template-repertoire-dependency-inspector.js';
import {
  // @ts-expect-error G3.2 remains an internal dependency inspection bridge.
  createProjectTemplateInstalledRepertoireDependencyInspectionPort as publicFactory,
} from '../src/index.js';

const port: ProjectTemplateRepertoireDependencyInspectionPort =
  createProjectTemplateInstalledRepertoireDependencyInspectionPort({
    projectRoot: '/project',
    language: 'ja',
    repertoireRoot: '/repertoire',
  });

void port.inspect;
// @ts-expect-error Inspection cannot apply filesystem mutations.
void port.apply;
// @ts-expect-error Inspection cannot claim planning authority.
void port.claim;
// @ts-expect-error Inspection cannot issue mutation leases.
void port.lease;
// @ts-expect-error Inspection does not expose write operations.
void port.write;

// The infra-private factory must not be re-exported from the root API.
void publicFactory;
