import { isIP } from 'node:net';
import { types } from 'node:util';

const MAX_LOCATION_LENGTH = 8_192;
const MAX_DNS_ANSWERS = 64;
const MAX_REDIRECTS = 3;
const MAX_ASSET_ID = BigInt(Number.MAX_SAFE_INTEGER);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_HOSTS = new Set([
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const ASSET_API_PATH =
  /^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/([1-9][0-9]*)$/;
const OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export type ProjectTemplateArtifactRedirectErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_REDIRECT'
  | 'REDIRECT_FORBIDDEN'
  | 'REDIRECT_LOOP'
  | 'REDIRECT_LIMIT'
  | 'DNS_REJECTED';

export class ProjectTemplateArtifactRedirectError extends Error {
  constructor(
    public readonly code: ProjectTemplateArtifactRedirectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateArtifactRedirectError';
  }
}

export interface DisposableProjectTemplateArtifactRedirectHop {
  dispose(): void;
}

export interface DisposableProjectTemplateArtifactRedirectGrant {
  consume(): DisposableProjectTemplateArtifactRedirectHop;
  dispose(): void;
}

export interface DisposableProjectTemplateArtifactRedirectState {
  resolve(
    statusCode: number,
    location: string,
  ): DisposableProjectTemplateArtifactRedirectGrant;
  dispose(): void;
}

interface RedirectStateAuthority {
  currentUrl: URL | undefined;
  visited: Set<string> | undefined;
  pendingGrant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
  children: Set<object> | undefined;
  redirectCount: number | undefined;
}

interface RedirectGrantAuthority {
  owner: DisposableProjectTemplateArtifactRedirectState | undefined;
  targetUrl: URL | undefined;
  identity: string | undefined;
}

interface RedirectHopAuthority {
  owner: RedirectStateAuthority | undefined;
  targetUrl: URL | undefined;
}

interface ProjectTemplateArtifactDnsAnswerSnapshot {
  readonly address: string;
  readonly family: 4 | 6;
  readonly bytes: readonly number[];
}

interface IpCidr {
  readonly prefix: readonly number[];
  readonly prefixLength: number;
}

// Versioned snapshot of ALLOCATED RIR prefixes from:
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.xhtml
// Last Updated: 2025-10-10.
//
// IANA reserves every unlisted part of 2000::/3 for future allocation. Keeping
// a dated allow-table prevents a registry change from silently widening this
// SSRF boundary; update this table and its first/last/neighbor tests together.
// The partially allocated 2001::/23 and special-purpose 2002::/16 are
// intentionally absent.
const IANA_ALLOCATED_IPV6_CIDRS = Object.freeze(([
  ['2001:200::', 23],
  ['2001:400::', 23],
  ['2001:600::', 23],
  ['2001:800::', 22],
  ['2001:c00::', 23],
  ['2001:e00::', 23],
  ['2001:1200::', 23],
  ['2001:1400::', 22],
  ['2001:1800::', 23],
  ['2001:1a00::', 23],
  ['2001:1c00::', 22],
  ['2001:2000::', 19],
  ['2001:4000::', 23],
  ['2001:4200::', 23],
  ['2001:4400::', 23],
  ['2001:4600::', 23],
  ['2001:4800::', 23],
  ['2001:4a00::', 23],
  ['2001:4c00::', 23],
  ['2001:5000::', 20],
  ['2001:8000::', 19],
  ['2001:a000::', 20],
  ['2001:b000::', 20],
  ['2003::', 18],
  ['2400::', 12],
  ['2410::', 12],
  ['2600::', 12],
  ['2610::', 23],
  ['2620::', 23],
  ['2630::', 12],
  ['2800::', 12],
  ['2a00::', 12],
  ['2a10::', 12],
  ['2c00::', 12],
] as const satisfies readonly (readonly [string, number])[]).map(
  ([address, prefixLength]) => createIpCidr(address, prefixLength),
));

const stateAuthorities = new WeakMap<
DisposableProjectTemplateArtifactRedirectState,
RedirectStateAuthority
>();
const grantAuthorities = new WeakMap<
DisposableProjectTemplateArtifactRedirectGrant,
RedirectGrantAuthority
>();
const hopAuthorities = new WeakMap<
DisposableProjectTemplateArtifactRedirectHop,
RedirectHopAuthority
>();
const stateFacades = new WeakSet<object>();
const grantFacades = new WeakSet<object>();
const hopFacades = new WeakSet<object>();

function redirectError(
  code: ProjectTemplateArtifactRedirectErrorCode,
): ProjectTemplateArtifactRedirectError {
  const messages: Record<ProjectTemplateArtifactRedirectErrorCode, string> = {
    INVALID_ARGUMENT: 'Artifact redirect input is invalid',
    INVALID_REDIRECT: 'Artifact redirect response is invalid',
    REDIRECT_FORBIDDEN: 'Artifact redirect target is forbidden',
    REDIRECT_LOOP: 'Artifact redirect loop was rejected',
    REDIRECT_LIMIT: 'Artifact redirect limit was exceeded',
    DNS_REJECTED: 'Artifact redirect DNS answers were rejected',
  };
  return Object.freeze(
    new ProjectTemplateArtifactRedirectError(code, messages[code]),
  );
}

function invalidArgument(): ProjectTemplateArtifactRedirectError {
  return redirectError('INVALID_ARGUMENT');
}

function invalidRedirect(): ProjectTemplateArtifactRedirectError {
  return redirectError('INVALID_REDIRECT');
}

function forbiddenRedirect(): ProjectTemplateArtifactRedirectError {
  return redirectError('REDIRECT_FORBIDDEN');
}

function isRawLocationSafe(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_LOCATION_LENGTH
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x5c) return false;
  }
  return true;
}

function locationHasForbiddenRawAuthority(location: string): boolean {
  const match =
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/.exec(location);
  if (match === null) return false;
  const authority = match[1]!;
  if (authority.includes('@')) return true;
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostAndPort.startsWith('[')) return true;
  const host = hostAndPort.split(':', 1)[0]!;
  return host !== host.toLowerCase() || !/^[a-z0-9.-]+$/.test(host);
}

function parseAllowedRedirectTarget(base: URL, location: unknown): URL {
  if (!isRawLocationSafe(location)) throw invalidRedirect();
  if (
    location.includes('#')
    || locationHasForbiddenRawAuthority(location)
  ) {
    throw forbiddenRedirect();
  }

  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    throw invalidRedirect();
  }
  const hostname = target.hostname;
  const unbracketedHostname = hostname.startsWith('[')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    target.protocol !== 'https:'
    || (target.port !== '' && target.port !== '443')
    || target.username !== ''
    || target.password !== ''
    || target.hash !== ''
    || hostname.endsWith('.')
    || hostname !== hostname.toLowerCase()
    || !/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith('[')
    || isIP(unbracketedHostname) !== 0
    || !REDIRECT_HOSTS.has(hostname)
  ) {
    throw forbiddenRedirect();
  }
  return target;
}

function parseCanonicalAssetApiUrl(value: unknown): URL {
  if (!isRawLocationSafe(value)) throw invalidArgument();
  if (value.includes('?') || value.includes('#')) throw invalidArgument();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidArgument();
  }
  const pathMatch = ASSET_API_PATH.exec(parsed.pathname);
  // The first request carries GitHub API authorization. Keeping this entry
  // point narrower than the redirect allowlist prevents future callers from
  // accidentally starting an authenticated request at an asset CDN.
  if (
    parsed.href !== value
    || parsed.protocol !== 'https:'
    || parsed.hostname !== 'api.github.com'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || pathMatch === null
  ) {
    throw invalidArgument();
  }
  const owner = pathMatch[1]!;
  const repo = pathMatch[2]!;
  const assetId = pathMatch[3]!;
  // Keep this transport boundary aligned with github-source-spec grammar so a
  // URL cannot bypass the portable repository-coordinate contract.
  if (
    !OWNER_PATTERN.test(owner)
    || owner.includes('--')
    || !REPOSITORY_PATTERN.test(repo)
    || repo === '.'
    || repo === '..'
    || repo.toLowerCase().endsWith('.git')
  ) {
    throw invalidArgument();
  }
  try {
    if (BigInt(assetId) > MAX_ASSET_ID) throw invalidArgument();
  } catch (error) {
    if (error instanceof ProjectTemplateArtifactRedirectError) throw error;
    throw invalidArgument();
  }
  return parsed;
}

function canonicalRedirectIdentity(target: URL): string {
  // Identity normalization is deliberately separate from targetUrl. Signed
  // GitHub asset URLs must be requested byte-for-byte as WHATWG serialized
  // them; only loop comparison decodes RFC 3986 unreserved escapes.
  return target.href.replace(/%([0-9A-Fa-f]{2})/g, (_match, rawHex: string) => {
    const code = Number.parseInt(rawHex, 16);
    const character = String.fromCharCode(code);
    return /^[A-Za-z0-9._~-]$/.test(character)
      ? character
      : `%${rawHex.toUpperCase()}`;
  });
}

function disposeGrantAuthority(
  grant: DisposableProjectTemplateArtifactRedirectGrant,
): void {
  const authority = grantAuthorities.get(grant);
  if (authority === undefined) return;
  const owner = authority.owner;
  authority.owner = undefined;
  authority.targetUrl = undefined;
  authority.identity = undefined;
  grantAuthorities.delete(grant);
  const ownerAuthority = owner === undefined
    ? undefined
    : stateAuthorities.get(owner);
  if (ownerAuthority?.pendingGrant === grant) {
    ownerAuthority.pendingGrant = undefined;
  }
  ownerAuthority?.children?.delete(grant);
}

function disposeHopAuthority(
  hop: DisposableProjectTemplateArtifactRedirectHop,
): void {
  const authority = hopAuthorities.get(hop);
  if (authority === undefined) return;
  authority.owner?.children?.delete(hop);
  authority.owner = undefined;
  authority.targetUrl = undefined;
  hopAuthorities.delete(hop);
}

function createRedirectHop(
  ownerAuthority: RedirectStateAuthority,
  targetUrl: URL,
): DisposableProjectTemplateArtifactRedirectHop {
  const hop = Object.freeze<DisposableProjectTemplateArtifactRedirectHop>({
    dispose(this: DisposableProjectTemplateArtifactRedirectHop): void {
      if (!hopFacades.has(this)) throw invalidArgument();
      disposeHopAuthority(this);
    },
  });
  hopFacades.add(hop);
  hopAuthorities.set(hop, { owner: ownerAuthority, targetUrl });
  ownerAuthority.children?.add(hop);
  return hop;
}

function createRedirectGrant(
  owner: DisposableProjectTemplateArtifactRedirectState,
  ownerAuthority: RedirectStateAuthority,
  targetUrl: URL,
  identity: string,
): DisposableProjectTemplateArtifactRedirectGrant {
  const grant = Object.freeze<DisposableProjectTemplateArtifactRedirectGrant>({
    consume(this: DisposableProjectTemplateArtifactRedirectGrant):
    DisposableProjectTemplateArtifactRedirectHop {
      const authority = grantAuthorities.get(this);
      if (
        authority === undefined
        || authority.owner === undefined
        || authority.targetUrl === undefined
        || authority.identity === undefined
      ) {
        throw invalidArgument();
      }
      const stateAuthority = stateAuthorities.get(authority.owner);
      if (
        stateAuthority === undefined
        || stateAuthority.pendingGrant !== this
        || stateAuthority.visited === undefined
        || stateAuthority.redirectCount === undefined
      ) {
        disposeGrantAuthority(this);
        throw invalidArgument();
      }
      const consumedTarget = authority.targetUrl;
      const consumedIdentity = authority.identity;
      stateAuthority.currentUrl = consumedTarget;
      stateAuthority.visited.add(consumedIdentity);
      stateAuthority.redirectCount += 1;
      disposeGrantAuthority(this);
      return createRedirectHop(stateAuthority, consumedTarget);
    },
    dispose(this: DisposableProjectTemplateArtifactRedirectGrant): void {
      if (!grantFacades.has(this)) throw invalidArgument();
      disposeGrantAuthority(this);
    },
  });
  grantFacades.add(grant);
  grantAuthorities.set(grant, { owner, targetUrl, identity });
  ownerAuthority.pendingGrant = grant;
  ownerAuthority.children?.add(grant);
  return grant;
}

export function createProjectTemplateArtifactRedirectState(
  baseCanonicalUrl: string,
): DisposableProjectTemplateArtifactRedirectState {
  const base = parseCanonicalAssetApiUrl(baseCanonicalUrl);
  const state = Object.freeze<DisposableProjectTemplateArtifactRedirectState>({
    resolve(
      this: DisposableProjectTemplateArtifactRedirectState,
      statusCode: number,
      location: string,
    ): DisposableProjectTemplateArtifactRedirectGrant {
      const authority = stateAuthorities.get(this);
      if (
        authority === undefined
        || authority.currentUrl === undefined
        || authority.visited === undefined
        || authority.redirectCount === undefined
        || authority.pendingGrant !== undefined
      ) {
        throw invalidArgument();
      }
      if (
        typeof statusCode !== 'number'
        || !Number.isSafeInteger(statusCode)
        || !REDIRECT_STATUSES.has(statusCode)
      ) {
        throw invalidRedirect();
      }
      const target = parseAllowedRedirectTarget(
        authority.currentUrl,
        location,
      );
      const identity = canonicalRedirectIdentity(target);
      if (authority.visited.has(identity)) {
        throw redirectError('REDIRECT_LOOP');
      }
      if (authority.redirectCount >= MAX_REDIRECTS) {
        throw redirectError('REDIRECT_LIMIT');
      }
      return createRedirectGrant(this, authority, target, identity);
    },
    dispose(this: DisposableProjectTemplateArtifactRedirectState): void {
      if (!stateFacades.has(this)) throw invalidArgument();
      const authority = stateAuthorities.get(this);
      if (authority === undefined) return;
      for (const child of authority.children ?? []) {
        if (grantFacades.has(child)) {
          disposeGrantAuthority(
            child as DisposableProjectTemplateArtifactRedirectGrant,
          );
        } else if (hopFacades.has(child)) {
          disposeHopAuthority(
            child as DisposableProjectTemplateArtifactRedirectHop,
          );
        }
      }
      authority.children?.clear();
      authority.visited?.clear();
      authority.currentUrl = undefined;
      authority.visited = undefined;
      authority.pendingGrant = undefined;
      authority.children = undefined;
      authority.redirectCount = undefined;
      stateAuthorities.delete(this);
    },
  });
  stateFacades.add(state);
  stateAuthorities.set(state, {
    currentUrl: base,
    visited: new Set([canonicalRedirectIdentity(base)]),
    pendingGrant: undefined,
    children: new Set(),
    redirectCount: 0,
  });
  return state;
}

function exactDnsAnswerRecord(value: unknown): {
  address: unknown;
  family: unknown;
} {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidArgument();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || !keys.includes('address')
    || !keys.includes('family')
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const address = descriptors['address'];
  const family = descriptors['family'];
  if (
    address === undefined
    || family === undefined
    || !('value' in address)
    || !('value' in family)
  ) {
    throw invalidArgument();
  }
  return { address: address.value, family: family.value };
}

function parseCanonicalIpv4(address: string): readonly number[] | undefined {
  if (!/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    return undefined;
  }
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets;
}

function parseIpv6(address: string): readonly number[] | undefined {
  if (
    address.includes('%')
    || address.length === 0
    || address.split('::').length > 2
  ) {
    return undefined;
  }
  const halves = address.split('::');
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 1 || halves[1] === ''
    ? []
    : halves[1]!.split(':');
  const groups = [...left, ...right];
  const expanded: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    if (group.includes('.')) {
      if (index !== groups.length - 1) return undefined;
      const ipv4 = parseCanonicalIpv4(group);
      if (ipv4 === undefined) return undefined;
      expanded.push((ipv4[0]! << 8) | ipv4[1]!);
      expanded.push((ipv4[2]! << 8) | ipv4[3]!);
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined;
      expanded.push(Number.parseInt(group, 16));
    }
  }
  if (halves.length === 1) {
    if (expanded.length !== 8) return undefined;
  } else {
    const missing = 8 - expanded.length;
    if (missing < 1) return undefined;
    expanded.splice(left.length, 0, ...new Array<number>(missing).fill(0));
  }
  if (expanded.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const group of expanded) {
    bytes.push(group >>> 8, group & 0xff);
  }
  return bytes;
}

function createIpCidr(address: string, prefixLength: number): IpCidr {
  const prefix = parseIpv6(address);
  if (
    prefix === undefined
    || !Number.isSafeInteger(prefixLength)
    || prefixLength < 0
    || prefixLength > prefix.length * 8
  ) {
    throw invalidArgument();
  }
  return Object.freeze({
    prefix: Object.freeze([...prefix]),
    prefixLength,
  });
}

function matchesCidr(
  address: readonly number[],
  cidr: IpCidr,
): boolean {
  if (
    address.length !== cidr.prefix.length
    || cidr.prefixLength < 0
    || cidr.prefixLength > address.length * 8
  ) {
    return false;
  }
  const completeBytes = Math.floor(cidr.prefixLength / 8);
  for (let index = 0; index < completeBytes; index += 1) {
    if (address[index] !== cidr.prefix[index]) return false;
  }
  const remainingBits = cidr.prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    (address[completeBytes]! & mask)
    === (cidr.prefix[completeBytes]! & mask)
  );
}

function isPublicIpv4(bytes: readonly number[]): boolean {
  const [a, b] = bytes;
  if (a === undefined || b === undefined) return false;
  return !(
    a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 88 && bytes[2] === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && bytes[2] === 100)
    || (a === 203 && b === 0 && bytes[2] === 113)
    || a >= 224
  );
}

function isPublicIpv6(bytes: readonly number[]): boolean {
  if (bytes.length !== 16) return false;
  if (!IANA_ALLOCATED_IPV6_CIDRS.some(
    (cidr) => matchesCidr(bytes, cidr),
  )) {
    return false;
  }
  const first = (bytes[0]! << 8) | bytes[1]!;
  const second = (bytes[2]! << 8) | bytes[3]!;
  const third = (bytes[4]! << 8) | bytes[5]!;
  // An ALLOCATED parent can still contain non-routable special-purpose child
  // ranges (for example 2001:db8::/32 inside 2001:c00::/23). Public therefore
  // means allocated AND not special-purpose, never merely table membership.
  if (
    first === 0x2002
    || first === 0x3ffe
    || (first === 0x3fff && (second & 0xf000) === 0)
    || (
      first === 0x2001
      && (
        second === 0x0000
        || (second === 0x0002 && third === 0)
        || (second & 0xfff0) === 0x0010
        || (second & 0xfff0) === 0x0020
        || second === 0x0db8
      )
    )
  ) {
    return false;
  }
  return true;
}

function snapshotPublicDnsAnswers(
  value: unknown,
): readonly ProjectTemplateArtifactDnsAnswerSnapshot[] {
  if (
    !Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw invalidArgument();
  }
  const keys = Reflect.ownKeys(value);
  if (
    value.length > MAX_DNS_ANSWERS
    || keys.length !== value.length + 1
    || keys[keys.length - 1] !== 'length'
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshots: ProjectTemplateArtifactDnsAnswerSnapshot[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalidArgument();
    }
    const record = exactDnsAnswerRecord(descriptor.value);
    if (
      typeof record.address !== 'string'
      || (record.family !== 4 && record.family !== 6)
    ) {
      throw invalidArgument();
    }
    const detectedFamily = isIP(record.address);
    if (detectedFamily !== 0 && detectedFamily !== record.family) {
      throw invalidArgument();
    }
    const bytes = record.family === 4
      ? parseCanonicalIpv4(record.address)
      : parseIpv6(record.address);
    if (
      bytes === undefined
      || detectedFamily !== record.family
      || (
        record.family === 4
          ? !isPublicIpv4(bytes)
          : !isPublicIpv6(bytes)
      )
    ) {
      throw redirectError('DNS_REJECTED');
    }
    snapshots.push(Object.freeze({
      address: record.address,
      family: record.family,
      bytes: Object.freeze([...bytes]),
    }));
  }
  if (snapshots.length === 0) throw redirectError('DNS_REJECTED');
  // The private immutable snapshot is intentionally ready for the next slice
  // to pin socket selection to the addresses that passed this validation.
  return Object.freeze(snapshots);
}

export function validateProjectTemplateArtifactDnsAnswers(
  value: unknown,
): void {
  snapshotPublicDnsAnswers(value);
}
