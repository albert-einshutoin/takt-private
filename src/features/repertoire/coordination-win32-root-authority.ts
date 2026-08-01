import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { userInfo } from 'node:os';
import { win32 } from 'node:path';

const COORDINATION_DIRECTORY_NAME = '.takt-repertoire-coordination';
const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const LOCAL_DRIVE_ROOT = /^[a-z]:\\/i;

export type WindowsRootFileStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly kind: 'directory' | 'other';
  readonly symbolicLink: boolean;
};

export type WindowsRootIdentityEvidence = {
  readonly dev: string;
  readonly ino: string;
};

export type WindowsCoordinationRootAuthority = {
  readonly lexicalRoot: string;
  readonly canonicalRoot: string;
  readonly evidence: WindowsRootIdentityEvidence;
  assertUnchanged(): void;
  close(): void;
};

export type WindowsRootAuthorityDependencies = {
  readonly capturedHomeDirectory: string;
  lstat(path: string): WindowsRootFileStat | undefined;
  realpath(path: string): string;
};

/** Generic failure that never exposes a profile path or filesystem detail. */
export class CoordinationWindowsRootAuthorityError extends Error {
  constructor() {
    super('Windows coordination root authority unavailable');
    this.name = 'CoordinationWindowsRootAuthorityError';
  }
}

/**
 * Builds the v1 Windows root authority around an OS-captured profile path.
 * The exact default root restriction is deliberate: without a native ACL
 * verifier, accepting caller-selected roots would silently widen the trust
 * boundary beyond the standard per-profile Windows ACL.
 */
export function createWindowsRootAuthorityOpener(
  dependencies: WindowsRootAuthorityDependencies,
): (path: string) => WindowsCoordinationRootAuthority {
  const capturedHomeDirectory = dependencies.capturedHomeDirectory;
  const expectedRoot = validateAndBuildExpectedRoot(capturedHomeDirectory);

  return (path: string): WindowsCoordinationRootAuthority => {
    try {
      assertExactDefaultRoot(path, expectedRoot);
      assertTrustedHierarchy(dependencies, capturedHomeDirectory, path);
      const canonicalHome = dependencies.realpath(capturedHomeDirectory);
      const canonicalRoot = dependencies.realpath(path);
      assertExactDefaultRoot(canonicalHome, capturedHomeDirectory);
      assertExactDefaultRoot(canonicalRoot, expectedRoot);
      if (!sameVolume(canonicalHome, canonicalRoot)) throw failed();

      const before = requireTrustedDirectory(dependencies.lstat(path));
      const home = requireTrustedDirectory(dependencies.lstat(capturedHomeDirectory));
      if (before.dev !== home.dev) throw failed();
      assertExistingCoordinationChildren(dependencies, path, before.dev);

      const after = requireTrustedDirectory(dependencies.lstat(path));
      if (!sameRootIdentity(before, after)) throw failed();

      let closed = false;
      const evidence = Object.freeze(toEvidence(before));
      return Object.freeze({
        lexicalRoot: path,
        canonicalRoot,
        evidence,
        assertUnchanged(): void {
          try {
            if (closed) throw failed();
            assertTrustedHierarchy(dependencies, capturedHomeDirectory, path);
            const currentCanonicalRoot = dependencies.realpath(path);
            assertExactDefaultRoot(currentCanonicalRoot, expectedRoot);
            const pathname = requireTrustedDirectory(dependencies.lstat(path));
            if (
              pathname.dev.toString() !== evidence.dev
              || pathname.ino.toString() !== evidence.ino
            ) throw failed();
            assertExistingCoordinationChildren(dependencies, path, pathname.dev);
          } catch {
            throw failed();
          }
        },
        close(): void {
          if (closed) return;
          // Terminalize before close: Windows may recycle the numeric handle
          // even when the close operation itself reports an error.
          closed = true;
          // Directory handles are intentionally not opened on Windows. The
          // regular sentinel fd becomes the retained lifetime seal later.
        },
      });
    } catch {
      throw failed();
    }
  };
}

const capturedWindowsHomeDirectory = userInfo().homedir;

const builtinWindowsDependencies: WindowsRootAuthorityDependencies = {
  capturedHomeDirectory: capturedWindowsHomeDirectory,
  lstat(path): WindowsRootFileStat | undefined {
    try {
      return fromBigIntStat(lstatSync(path, { bigint: true }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  realpath: realpathSync,
};

/** Production opener; captures the OS profile independently of env overrides. */
export function openBuiltinWindowsRootAuthority(path: string): WindowsCoordinationRootAuthority {
  return createWindowsRootAuthorityOpener(builtinWindowsDependencies)(path);
}

function validateAndBuildExpectedRoot(home: string): string {
  assertSafeLocalPath(home);
  return win32.join(home, '.takt');
}

function assertExactDefaultRoot(actual: string, expected: string): void {
  assertSafeLocalPath(actual);
  if (actual.toLowerCase() !== expected.toLowerCase()) throw failed();
}

function assertSafeLocalPath(path: string): void {
  if (
    typeof path !== 'string'
    || !win32.isAbsolute(path)
    || !LOCAL_DRIVE_ROOT.test(path)
    || path.startsWith('\\\\')
    || win32.normalize(path) !== path
    || path.slice(2).includes(':')
  ) throw failed();
  const segments = path.slice(3).split('\\');
  for (const segment of segments) {
    if (
      segment.length === 0
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || RESERVED_SEGMENT.test(segment)
    ) throw failed();
  }
}

function assertTrustedHierarchy(
  dependencies: WindowsRootAuthorityDependencies,
  home: string,
  root: string,
): void {
  for (const path of hierarchyPaths(home)) requireTrustedDirectory(dependencies.lstat(path));
  requireTrustedDirectory(dependencies.lstat(root));
}

function hierarchyPaths(path: string): string[] {
  const driveRoot = path.slice(0, 3);
  const paths = [driveRoot];
  let current = driveRoot;
  for (const segment of path.slice(3).split('\\')) {
    current = win32.join(current, segment);
    paths.push(current);
  }
  return paths;
}

function assertExistingCoordinationChildren(
  dependencies: WindowsRootAuthorityDependencies,
  root: string,
  expectedDevice: bigint,
): void {
  const coordinationRoot = win32.join(root, COORDINATION_DIRECTORY_NAME);
  for (const path of [
    coordinationRoot,
    win32.join(coordinationRoot, 'readers'),
    win32.join(coordinationRoot, 'released'),
  ]) {
    const stat = dependencies.lstat(path);
    if (stat === undefined) continue;
    const directory = requireTrustedDirectory(stat);
    if (directory.dev !== expectedDevice) throw failed();
  }
}

function requireTrustedDirectory(stat: WindowsRootFileStat | undefined): WindowsRootFileStat {
  if (stat === undefined || stat.kind !== 'directory' || stat.symbolicLink) throw failed();
  return stat;
}

function sameRootIdentity(left: WindowsRootFileStat, right: WindowsRootFileStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino;
}

function toEvidence(stat: WindowsRootFileStat): WindowsRootIdentityEvidence {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  };
}

function fromBigIntStat(stat: BigIntStats): WindowsRootFileStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    kind: stat.isDirectory() ? 'directory' : 'other',
    symbolicLink: stat.isSymbolicLink(),
  };
}

function sameVolume(left: string, right: string): boolean {
  return left.slice(0, 2).toLowerCase() === right.slice(0, 2).toLowerCase();
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function failed(): CoordinationWindowsRootAuthorityError {
  return new CoordinationWindowsRootAuthorityError();
}
