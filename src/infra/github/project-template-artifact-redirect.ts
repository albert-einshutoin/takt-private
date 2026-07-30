import {
  lookup as dnsLookup,
  type LookupAddress,
} from 'node:dns';
import { EventEmitter } from 'node:events';
import {
  request as httpsRequest,
  type RequestOptions,
} from 'node:https';
import type { ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { types } from 'node:util';

const MAX_LOCATION_LENGTH = 8_192;
const MAX_DNS_ANSWERS = 64;
const MAX_PINNED_RAW_HEADER_ENTRIES = 256;
const MAX_PINNED_RAW_HEADER_CHARACTERS = 64 * 1024;
const MAX_IPV4_ADDRESS_LENGTH = 15;
const MAX_IPV6_ADDRESS_LENGTH = 45;
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

declare const ARTIFACT_REDIRECT_HOP_BRAND: unique symbol;

export interface DisposableProjectTemplateArtifactRedirectHop {
  readonly [ARTIFACT_REDIRECT_HOP_BRAND]: never;
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
  baseUrl: URL | undefined;
  baseIdentity: string | undefined;
  currentUrl: URL | undefined;
  visited: Set<string> | undefined;
  pendingGrant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
  children: Set<object> | undefined;
  redirectCount: number | undefined;
  bootstrapAvailable: boolean;
  phase: 'pristine' | 'bootstrap-pending' | 'active' | undefined;
}

interface RedirectGrantAuthority {
  owner: DisposableProjectTemplateArtifactRedirectState | undefined;
  targetUrl: URL | undefined;
  identity: string | undefined;
  countsTowardLimit: boolean | undefined;
}

interface RedirectHopAuthority {
  state: DisposableProjectTemplateArtifactRedirectState | undefined;
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
  const countsTowardLimit = authority.countsTowardLimit;
  authority.countsTowardLimit = undefined;
  grantAuthorities.delete(grant);
  const ownerAuthority = owner === undefined
    ? undefined
    : stateAuthorities.get(owner);
  if (ownerAuthority?.pendingGrant === grant) {
    ownerAuthority.pendingGrant = undefined;
  }
  if (
    countsTowardLimit === false
    && ownerAuthority?.phase === 'bootstrap-pending'
  ) {
    // A discarded bootstrap grant spends no state and may be retried. Only
    // consume() commits the transition away from pristine authority.
    ownerAuthority.phase = 'pristine';
    ownerAuthority.bootstrapAvailable = true;
  }
  ownerAuthority?.children?.delete(grant);
}

function disposeHopAuthority(
  hop: DisposableProjectTemplateArtifactRedirectHop,
): void {
  const authority = hopAuthorities.get(hop);
  if (authority === undefined) return;
  authority.owner?.children?.delete(hop);
  authority.state = undefined;
  authority.owner = undefined;
  authority.targetUrl = undefined;
  hopAuthorities.delete(hop);
}

function createRedirectHop(
  state: DisposableProjectTemplateArtifactRedirectState,
  ownerAuthority: RedirectStateAuthority,
  targetUrl: URL,
): DisposableProjectTemplateArtifactRedirectHop {
  const hop = Object.freeze({
    dispose(this: DisposableProjectTemplateArtifactRedirectHop): void {
      if (!hopFacades.has(this)) throw invalidArgument();
      disposeHopAuthority(this);
    },
  }) as DisposableProjectTemplateArtifactRedirectHop;
  hopFacades.add(hop);
  hopAuthorities.set(hop, {
    state,
    owner: ownerAuthority,
    targetUrl,
  });
  ownerAuthority.children?.add(hop);
  return hop;
}

function createRedirectGrant(
  owner: DisposableProjectTemplateArtifactRedirectState,
  ownerAuthority: RedirectStateAuthority,
  targetUrl: URL,
  identity: string,
  countsTowardLimit: boolean,
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
        || authority.countsTowardLimit === undefined
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
      const countsTowardLimit = authority.countsTowardLimit;
      stateAuthority.currentUrl = consumedTarget;
      stateAuthority.visited.add(consumedIdentity);
      if (countsTowardLimit) stateAuthority.redirectCount += 1;
      const state = authority.owner;
      disposeGrantAuthority(this);
      stateAuthority.bootstrapAvailable = false;
      stateAuthority.phase = 'active';
      return createRedirectHop(state, stateAuthority, consumedTarget);
    },
    dispose(this: DisposableProjectTemplateArtifactRedirectGrant): void {
      if (!grantFacades.has(this)) throw invalidArgument();
      disposeGrantAuthority(this);
    },
  });
  grantFacades.add(grant);
  grantAuthorities.set(grant, {
    owner,
    targetUrl,
    identity,
    countsTowardLimit,
  });
  ownerAuthority.pendingGrant = grant;
  ownerAuthority.children?.add(grant);
  return grant;
}

function resolveRedirectGrant(
  state: DisposableProjectTemplateArtifactRedirectState,
  authority: RedirectStateAuthority,
  statusCode: number,
  location: string,
  countsTowardLimit: boolean,
): DisposableProjectTemplateArtifactRedirectGrant {
  if (
    authority.currentUrl === undefined
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
  if (countsTowardLimit && authority.redirectCount >= MAX_REDIRECTS) {
    throw redirectError('REDIRECT_LIMIT');
  }
  const grant = createRedirectGrant(
    state,
    authority,
    target,
    identity,
    countsTowardLimit,
  );
  if (!countsTowardLimit) {
    authority.bootstrapAvailable = false;
    authority.phase = 'bootstrap-pending';
  }
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
      if (authority === undefined) throw invalidArgument();
      return resolveRedirectGrant(
        this,
        authority,
        statusCode,
        location,
        true,
      );
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
      authority.baseUrl = undefined;
      authority.baseIdentity = undefined;
      authority.currentUrl = undefined;
      authority.visited = undefined;
      authority.pendingGrant = undefined;
      authority.children = undefined;
      authority.redirectCount = undefined;
      authority.bootstrapAvailable = false;
      authority.phase = undefined;
      stateAuthorities.delete(this);
    },
  });
  stateFacades.add(state);
  const baseIdentity = canonicalRedirectIdentity(base);
  stateAuthorities.set(state, {
    baseUrl: base,
    baseIdentity,
    currentUrl: base,
    visited: new Set([baseIdentity]),
    pendingGrant: undefined,
    children: new Set(),
    redirectCount: 0,
    bootstrapAvailable: true,
    phase: 'pristine',
  });
  return state;
}

/**
 * Establishes the authenticated API response as the uncounted starting point
 * for the private unauthenticated artifact redirect chain.
 *
 * @internal
 */
export function bootstrapProjectTemplateArtifactRedirect(
  state: DisposableProjectTemplateArtifactRedirectState,
  statusCode: number,
  location: string,
): DisposableProjectTemplateArtifactRedirectGrant {
  const authority = (
    typeof state === 'object'
    && state !== null
    && !types.isProxy(state)
    && stateFacades.has(state)
  )
    ? stateAuthorities.get(state)
    : undefined;
  if (
    authority === undefined
    || authority.phase !== 'pristine'
    || !authority.bootstrapAvailable
    || authority.baseUrl === undefined
    || authority.baseIdentity === undefined
    || authority.currentUrl !== authority.baseUrl
    || authority.redirectCount !== 0
    || authority.pendingGrant !== undefined
    || authority.visited?.size !== 1
    || !authority.visited.has(authority.baseIdentity)
  ) {
    throw invalidArgument();
  }
  return resolveRedirectGrant(
    state,
    authority,
    statusCode,
    location,
    false,
  );
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
    // Canonical IPv4/IPv6 text cannot exceed these RFC representation bounds.
    // Reject by length before native or string parsing so hostile DNS adapters
    // cannot turn one answer into unbounded validation work.
    const maximumAddressLength = record.family === 4
      ? MAX_IPV4_ADDRESS_LENGTH
      : MAX_IPV6_ADDRESS_LENGTH;
    if (
      record.address.length === 0
      || record.address.length > maximumAddressLength
    ) {
      throw redirectError('DNS_REJECTED');
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

export interface ProjectTemplateArtifactPinnedTransportHandlers {
  readonly onDnsRejected: () => void;
  readonly onResponse: (statusCode: number) => void;
  readonly onInvalidResponse: () => void;
  readonly onData: (chunk: unknown) => void;
  readonly onEnd: () => void;
  readonly onResponseAborted: () => void;
  readonly onResponseError: () => void;
  readonly onResponseClose: () => void;
  readonly onRequestError: () => void;
  readonly onRequestClose: () => void;
}

export interface ProjectTemplateArtifactPinnedTransport {
  start(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  dispose(): void;
}

interface PinnedTransportAttempt {
  readonly generation: number;
  targetUrl?: URL;
  readonly secrets: {
    active: boolean;
    hostname?: string;
    snapshot?: readonly ProjectTemplateArtifactDnsAnswerSnapshot[];
  };
  request?: ClientRequest;
  requestDestroy?: (...args: unknown[]) => unknown;
  requestEnd?: (...args: unknown[]) => unknown;
  requestListeners: ReadonlyArray<
    readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  dnsSettled: boolean;
  responseDelivered: boolean;
  responseSeen: boolean;
  requestTerminalDelivered: boolean;
}

type PinnedTransportPhase =
  | 'idle'
  | 'redirect-attempt'
  | 'accepting-body'
  | 'body-paused'
  | 'body-streaming'
  | 'terminal'
  | 'disposed';

type PinnedTransportBodyEventKind =
  | 'data'
  | 'end'
  | 'aborted'
  | 'error'
  | 'close';

interface PinnedTransportBodyListenerToken {
  active: boolean;
  dispatch?: (
    event: PinnedTransportBodyEventKind,
    chunk?: unknown,
  ) => void;
}

interface PinnedTransportBody {
  readonly listenerToken: PinnedTransportBodyListenerToken;
  response?: Readable;
  pause?: (...args: unknown[]) => unknown;
  resume?: (...args: unknown[]) => unknown;
  destroy?: (...args: unknown[]) => unknown;
  responseListeners: ReadonlyArray<
    readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  request?: ClientRequest;
  requestDestroy?: (...args: unknown[]) => unknown;
  requestListeners: PinnedTransportAttempt['requestListeners'];
}

type PinnedTransportPumpEvent =
  | {
    readonly kind: 'begin';
    readonly targetUrl: URL;
  }
  | {
    readonly kind: 'dns';
    readonly attempt: PinnedTransportAttempt;
    readonly snapshot:
      readonly ProjectTemplateArtifactDnsAnswerSnapshot[] | undefined;
  }
  | {
    readonly kind: 'response';
    readonly attempt: PinnedTransportAttempt;
    readonly response: unknown;
  }
  | {
    readonly kind: 'request-terminal';
    readonly attempt: PinnedTransportAttempt;
    readonly notification: 'onRequestError' | 'onRequestClose';
  }
  | {
    readonly kind: 'body-event';
    readonly token: PinnedTransportBodyListenerToken;
    readonly event: PinnedTransportBodyEventKind;
    chunk?: unknown;
  };

interface PinnedTransportAuthority {
  state?: DisposableProjectTemplateArtifactRedirectState;
  initialTargetUrl?: URL;
  activeAttempt?: PinnedTransportAttempt;
  pumpQueue: PinnedTransportPumpEvent[];
  generation: number;
  draining: boolean;
  phase: PinnedTransportPhase;
  body?: PinnedTransportBody;
  release: () => void;
}

const pinnedTransportAuthorities = new WeakMap<
  object,
  PinnedTransportAuthority
>();
const pinnedTransportFacades = new WeakSet<object>();

function createPinnedBodyListener(
  token: PinnedTransportBodyListenerToken,
  event: PinnedTransportBodyEventKind,
): (...args: unknown[]) => void {
  return (value?: unknown) => {
    if (!token.active) return;
    const dispatch = token.dispatch;
    if (dispatch !== undefined) {
      Reflect.apply(
        dispatch,
        undefined,
        event === 'data' ? [event, value] : [event],
      );
    }
  };
}

function exactPinnedHandlers(
  value: unknown,
): Record<
  keyof ProjectTemplateArtifactPinnedTransportHandlers,
  (...args: unknown[]) => unknown
> {
  const names = [
    'onDnsRejected',
    'onResponse',
    'onInvalidResponse',
    'onData',
    'onEnd',
    'onResponseAborted',
    'onResponseError',
    'onResponseClose',
    'onRequestError',
    'onRequestClose',
  ] as const;
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
    keys.length !== names.length
    || names.some((name) => !keys.includes(name))
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {} as Record<
    keyof ProjectTemplateArtifactPinnedTransportHandlers,
    (...args: unknown[]) => unknown
  >;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (
      descriptor === undefined
      || !('value' in descriptor)
      || typeof descriptor.value !== 'function'
      || types.isProxy(descriptor.value)
    ) {
      throw invalidArgument();
    }
    result[name] = descriptor.value;
  }
  return result;
}

function findPinnedMethod(
  value: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
  ) {
    return undefined;
  }
  try {
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 8; depth += 1) {
      // A proxy anywhere in the prototype chain could run attacker-controlled
      // descriptor traps while this code is trying to contain an invalid
      // native return value, so reject the whole chain before inspecting it.
      if (types.isProxy(current)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        return 'value' in descriptor
          && typeof descriptor.value === 'function'
          && !types.isProxy(descriptor.value)
          ? descriptor.value as (...args: unknown[]) => unknown
          : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    // Hostile prototypes and monkey-patched reflection must remain contained.
  }
  return undefined;
}

function findPinnedData(value: unknown, name: string): unknown {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
  ) {
    return undefined;
  }
  try {
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 8; depth += 1) {
      if (types.isProxy(current)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        return 'value' in descriptor ? descriptor.value : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    // Native response reflection is an untrusted runtime boundary.
  }
  return undefined;
}

function isPinnedReadable(value: unknown): value is Readable {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
  ) {
    return false;
  }
  try {
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 8; depth += 1) {
      if (types.isProxy(current)) return false;
      if (current === Readable.prototype) return true;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return false;
  }
  return false;
}

function snapshotPinnedRedirectLocation(response: unknown): string | undefined {
  const rawHeaders = findPinnedData(response, 'rawHeaders');
  try {
    if (
      !Array.isArray(rawHeaders)
      || types.isProxy(rawHeaders)
      || Object.getPrototypeOf(rawHeaders) !== Array.prototype
      || rawHeaders.length === 0
      || rawHeaders.length > MAX_PINNED_RAW_HEADER_ENTRIES
      || rawHeaders.length % 2 !== 0
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(rawHeaders);
    if (
      keys.length !== rawHeaders.length + 1
      || keys[keys.length - 1] !== 'length'
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(rawHeaders);
    let characters = 0;
    let location: string | undefined;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const nameDescriptor = descriptors[String(index)];
      const valueDescriptor = descriptors[String(index + 1)];
      if (
        nameDescriptor === undefined
        || valueDescriptor === undefined
        || !('value' in nameDescriptor)
        || !('value' in valueDescriptor)
        || typeof nameDescriptor.value !== 'string'
        || typeof valueDescriptor.value !== 'string'
      ) {
        return undefined;
      }
      const name = nameDescriptor.value;
      const value = valueDescriptor.value;
      characters += name.length + value.length;
      if (characters > MAX_PINNED_RAW_HEADER_CHARACTERS) return undefined;
      if (name.toLowerCase() !== 'location') continue;
      if (
        location !== undefined
        || value.length < 1
        || value.length > MAX_LOCATION_LENGTH
      ) {
        return undefined;
      }
      location = value;
    }
    return location;
  } catch {
    return undefined;
  }
}

function createRevocablePinnedLookup(
  secrets: PinnedTransportAttempt['secrets'],
): NonNullable<RequestOptions['lookup']> {
  return (requestedHostname, options, callback) => {
    const activeHostname = secrets.hostname;
    const activeSnapshot = secrets.snapshot;
    const requestedFamily = options.family ?? 0;
    const family = requestedFamily === 'IPv4'
      ? 4
      : requestedFamily === 'IPv6'
        ? 6
        : requestedFamily;
    const all = options.all ?? false;
    if (
      !secrets.active
      || activeHostname === undefined
      || activeSnapshot === undefined
      || requestedHostname !== activeHostname
      || (family !== 0 && family !== 4 && family !== 6)
      || typeof all !== 'boolean'
    ) {
      Reflect.apply(callback, undefined, [invalidArgument()]);
      return;
    }
    const matches = activeSnapshot.filter(
      (answer) => family === 0 || answer.family === family,
    );
    if (matches.length === 0) {
      Reflect.apply(callback, undefined, [invalidArgument()]);
      return;
    }
    if (all) {
      Reflect.apply(callback, undefined, [
        null,
        matches.map((answer) => ({
          address: answer.address,
          family: answer.family,
        })),
      ]);
    } else {
      const selected = matches[0]!;
      Reflect.apply(callback, undefined, [
        null,
        selected.address,
        selected.family,
      ]);
    }
  };
}

/**
 * Creates the unauthenticated transport for a validated redirect hop.
 *
 * This factory deliberately lives beside the private hop and DNS authorities:
 * neither the signed URL nor validated addresses can cross a public seam, and
 * no credential-shaped value can satisfy the nominal hop capability.
 */
export function createProjectTemplateArtifactPinnedTransport(
  initialHop: DisposableProjectTemplateArtifactRedirectHop,
  handlersValue: ProjectTemplateArtifactPinnedTransportHandlers,
): ProjectTemplateArtifactPinnedTransport {
  const handlers = exactPinnedHandlers(handlersValue);
  const handlerReceiver = handlersValue;
  const hopAuthority = (
    typeof initialHop === 'object'
    && initialHop !== null
    && !types.isProxy(initialHop)
  )
    ? hopAuthorities.get(initialHop)
    : undefined;
  if (
    hopAuthority === undefined
    || hopAuthority.state === undefined
    || hopAuthority.owner === undefined
    || hopAuthority.targetUrl === undefined
    || !stateAuthorities.has(hopAuthority.state)
  ) {
    throw invalidArgument();
  }

  const holder: { current?: PinnedTransportAuthority } = {};
  // Move secret-bearing values directly into the one clearable authority.
  // Factory locals captured by facade callbacks therefore never own the URL
  // or redirect state after this point.
  const authority: PinnedTransportAuthority = {
    state: hopAuthority.state,
    initialTargetUrl: hopAuthority.targetUrl,
    pumpQueue: [],
    generation: 0,
    draining: false,
    phase: 'idle',
    release: () => {
      holder.current = undefined;
    },
  };
  hopAuthority.owner.children?.delete(initialHop);
  hopAuthority.state = undefined;
  hopAuthority.owner = undefined;
  hopAuthority.targetUrl = undefined;
  hopAuthorities.delete(initialHop);
  holder.current = authority;

  const invoke = (
    name: keyof ProjectTemplateArtifactPinnedTransportHandlers,
    args: readonly unknown[] = [],
  ): boolean => {
    try {
      Reflect.apply(handlers[name], handlerReceiver, args);
      return true;
    } catch {
      return false;
    }
  };
  const isStopped = (current: PinnedTransportAuthority): boolean =>
    current.phase === 'terminal' || current.phase === 'disposed';
  const isDisposed = (current: PinnedTransportAuthority): boolean =>
    current.phase === 'disposed';
  const removeRequestListeners = (
    request: ClientRequest | undefined,
    listeners: PinnedTransportAttempt['requestListeners'],
  ): boolean => {
    if (request === undefined) return true;
    let succeeded = true;
    for (const [event, listener] of listeners) {
      try {
        EventEmitter.prototype.removeListener.call(
          request,
          event,
          listener,
        );
      } catch {
        succeeded = false;
      }
    }
    return succeeded;
  };
  const destroyRequest = (
    request: ClientRequest | undefined,
    destroy: ((...args: unknown[]) => unknown) | undefined,
  ): boolean => {
    if (request === undefined) return true;
    if (destroy === undefined) return false;
    try {
      Reflect.apply(destroy, request, []);
      return true;
    } catch {
      return false;
    }
  };
  const containedResponses = new WeakSet<object>();
  const responseQueue: object[] = [];
  let drainingResponses = false;
  const containResponse = (response: unknown): void => {
    if (
      typeof response !== 'object'
      || response === null
      || types.isProxy(response)
      || containedResponses.has(response)
    ) {
      return;
    }
    containedResponses.add(response);
    responseQueue.push(response);
    if (drainingResponses) return;
    drainingResponses = true;
    let cursor = 0;
    try {
      while (cursor < responseQueue.length) {
        const candidate = responseQueue[cursor];
        cursor += 1;
        if (candidate === undefined) continue;
        const destroy = findPinnedMethod(candidate, 'destroy');
        if (destroy === undefined) continue;
        try {
          Reflect.apply(destroy, candidate, []);
        } catch {
          // Late response details never reach a handler or error.
        }
      }
    } finally {
      responseQueue.length = 0;
      drainingResponses = false;
    }
  };
  const destroyCurrentResponse = (response: unknown): boolean => {
    if (
      typeof response !== 'object'
      || response === null
      || types.isProxy(response)
      || containedResponses.has(response)
    ) {
      return false;
    }
    containedResponses.add(response);
    const destroy = findPinnedMethod(response, 'destroy');
    if (destroy === undefined) return false;
    try {
      Reflect.apply(destroy, response, []);
      return true;
    } catch {
      return false;
    }
  };
  const detachAttempt = (
    authority: PinnedTransportAuthority,
    expected?: PinnedTransportAttempt,
  ): Readonly<{
    request: ClientRequest | undefined;
    requestDestroy: ((...args: unknown[]) => unknown) | undefined;
    listeners: PinnedTransportAttempt['requestListeners'];
  }> | undefined => {
    const attempt = authority.activeAttempt;
    if (
      attempt === undefined
      || (expected !== undefined && attempt !== expected)
    ) {
      return undefined;
    }
    const detached = Object.freeze({
      request: attempt.request,
      requestDestroy: attempt.requestDestroy,
      listeners: Object.freeze([...attempt.requestListeners]),
    });
    // Clear secret-bearing holders before any listener removal or destroy can
    // re-enter through an externally retained request or callback token.
    authority.activeAttempt = undefined;
    attempt.targetUrl = undefined;
    attempt.secrets.active = false;
    attempt.secrets.hostname = undefined;
    attempt.secrets.snapshot = undefined;
    attempt.request = undefined;
    attempt.requestDestroy = undefined;
    attempt.requestEnd = undefined;
    attempt.requestListeners = [];
    return detached;
  };
  const cleanDetachedAttempt = (
    detached: NonNullable<ReturnType<typeof detachAttempt>>,
    response?: unknown,
  ): boolean => {
    const listenersRemoved = removeRequestListeners(
      detached.request,
      detached.listeners,
    );
    const responseDestroyed = response === undefined
      ? true
      : destroyCurrentResponse(response);
    const requestDestroyed = destroyRequest(
      detached.request,
      detached.requestDestroy,
    );
    return listenersRemoved && responseDestroyed && requestDestroyed;
  };
  const detachBody = (
    current: PinnedTransportAuthority,
    expected?: PinnedTransportBody,
  ): Readonly<{
    response: Readable | undefined;
    destroy: ((...args: unknown[]) => unknown) | undefined;
    responseListeners: PinnedTransportBody['responseListeners'];
    request: ClientRequest | undefined;
    requestDestroy: ((...args: unknown[]) => unknown) | undefined;
    requestListeners: PinnedTransportAttempt['requestListeners'];
  }> | undefined => {
    const body = current.body;
    if (body === undefined || (expected !== undefined && body !== expected)) {
      return undefined;
    }
    current.body = undefined;
    // Revoke the only object captured by externally retainable listeners
    // before copying or cleaning any event-capable resource.
    body.listenerToken.active = false;
    body.listenerToken.dispatch = undefined;
    const detached = Object.freeze({
      response: body.response,
      destroy: body.destroy,
      responseListeners: Object.freeze([...body.responseListeners]),
      request: body.request,
      requestDestroy: body.requestDestroy,
      requestListeners: Object.freeze([...body.requestListeners]),
    });
    body.response = undefined;
    body.pause = undefined;
    body.resume = undefined;
    body.destroy = undefined;
    body.responseListeners = [];
    body.request = undefined;
    body.requestDestroy = undefined;
    body.requestListeners = [];
    return detached;
  };
  const cleanDetachedBody = (
    body: NonNullable<ReturnType<typeof detachBody>>,
  ): boolean => {
    let succeeded = removeRequestListeners(
      body.request,
      body.requestListeners,
    );
    if (body.response !== undefined) {
      for (const [event, listener] of body.responseListeners) {
        try {
          EventEmitter.prototype.removeListener.call(
            body.response,
            event,
            listener,
          );
        } catch {
          succeeded = false;
        }
      }
    }
    if (body.response === undefined || body.destroy === undefined) {
      succeeded = false;
    } else {
      try {
        Reflect.apply(body.destroy, body.response, []);
      } catch {
        succeeded = false;
      }
    }
    if (!destroyRequest(body.request, body.requestDestroy)) succeeded = false;
    return succeeded;
  };
  const releaseDetachedBody = (
    body: NonNullable<ReturnType<typeof detachBody>>,
  ): void => {
    removeRequestListeners(body.request, body.requestListeners);
    if (body.response === undefined) return;
    for (const [event, listener] of body.responseListeners) {
      try {
        EventEmitter.prototype.removeListener.call(
          body.response,
          event,
          listener,
        );
      } catch {
        // End already owns the terminal outcome; listener revocation remains
        // authoritative even when host cleanup is monkey-patched.
      }
    }
  };
  const clearPendingEvents = (
    events: PinnedTransportPumpEvent[],
  ): void => {
    for (const event of events) {
      if (event.kind === 'response') containResponse(event.response);
      if (event.kind === 'body-event') event.chunk = undefined;
    }
    events.length = 0;
  };
  const terminate = (
    authority: PinnedTransportAuthority,
    notification?: keyof ProjectTemplateArtifactPinnedTransportHandlers,
    response?: unknown,
  ): void => {
    if (isStopped(authority)) {
      if (response !== undefined) containResponse(response);
      return;
    }
    authority.phase = 'terminal';
    authority.initialTargetUrl = undefined;
    authority.release();
    const detached = detachAttempt(authority);
    const detachedBody = detachBody(authority);
    const ownedState = authority.state;
    authority.state = undefined;
    const pendingEvents = authority.pumpQueue.splice(0);
    if (detached !== undefined) {
      cleanDetachedAttempt(detached, response);
    } else if (detachedBody !== undefined) {
      cleanDetachedBody(detachedBody);
      if (
        response !== undefined
        && response !== detachedBody.response
      ) {
        containResponse(response);
      }
    } else if (response !== undefined) {
      containResponse(response);
    }
    try {
      ownedState?.dispose();
    } catch {
      // Terminal capability deletion remains authoritative.
    }
    clearPendingEvents(pendingEvents);
    if (isDisposed(authority)) return;
    if (notification !== undefined) {
      invoke(notification);
    }
  };
  const moveNextHop = (
    current: PinnedTransportAuthority,
    statusCode: number,
    location: string,
  ): URL | undefined => {
    const ownedState = current.state;
    if (ownedState === undefined) return undefined;
    let grant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
    let hop: DisposableProjectTemplateArtifactRedirectHop | undefined;
    try {
      grant = ownedState.resolve(statusCode, location);
      hop = grant.consume();
      grant = undefined;
      const nextAuthority = hopAuthorities.get(hop);
      if (
        nextAuthority === undefined
        || nextAuthority.state !== ownedState
        || nextAuthority.owner === undefined
        || nextAuthority.targetUrl === undefined
        || !stateAuthorities.has(ownedState)
      ) {
        throw invalidArgument();
      }
      const nextTargetUrl = nextAuthority.targetUrl;
      nextAuthority.owner.children?.delete(hop);
      nextAuthority.state = undefined;
      nextAuthority.owner = undefined;
      nextAuthority.targetUrl = undefined;
      hopAuthorities.delete(hop);
      hop = undefined;
      return nextTargetUrl;
    } catch {
      try {
        grant?.dispose();
      } catch {
        // State disposal on terminal failure remains authoritative.
      }
      try {
        hop?.dispose();
      } catch {
        // State disposal on terminal failure remains authoritative.
      }
      return undefined;
    }
  };

  let drainPump = (): void => {};
  const enqueue = (event: PinnedTransportPumpEvent): void => {
    if (isStopped(authority)) {
      if (event.kind === 'response') containResponse(event.response);
      if (event.kind === 'body-event') event.chunk = undefined;
      return;
    }
    authority.pumpQueue.push(event);
    drainPump();
  };

  const createAttemptDnsCallback = (
    current: PinnedTransportAuthority,
    attempt: PinnedTransportAttempt,
  ): (error: NodeJS.ErrnoException | null, answers: LookupAddress[]) => void => {
    let callbackDelivered = false;
    return (error, answers) => {
      if (callbackDelivered) return;
      callbackDelivered = true;
      let snapshot:
        readonly ProjectTemplateArtifactDnsAnswerSnapshot[] | undefined;
      if (
        current.activeAttempt === attempt
        && !isStopped(current)
        && error === null
      ) {
        try {
          // Snapshot while the resolver still owns the callback frame;
          // adapters may mutate or reuse their answer array on return.
          snapshot = snapshotPublicDnsAnswers(answers);
        } catch {
          snapshot = undefined;
        }
      }
      enqueue({
        kind: 'dns',
        attempt,
        snapshot,
      });
    };
  };

  const beginAttempt = (
    current: PinnedTransportAuthority,
    url: URL,
  ): void => {
    if (
      current.activeAttempt !== undefined
      || isStopped(current)
      || current.phase !== 'redirect-attempt'
      || holder.current !== current
    ) {
      terminate(current, 'onInvalidResponse');
      return;
    }
    const attempt: PinnedTransportAttempt = {
      generation: current.generation + 1,
      targetUrl: url,
      secrets: { active: true },
      requestListeners: [],
      dnsSettled: false,
      responseDelivered: false,
      responseSeen: false,
      requestTerminalDelivered: false,
    };
    current.generation = attempt.generation;
    current.activeAttempt = attempt;
    const dnsCallback = createAttemptDnsCallback(current, attempt);
    try {
      dnsLookup(
        url.hostname,
        { all: true, verbatim: true },
        dnsCallback,
      );
    } catch {
      terminate(current, 'onDnsRejected');
    }
  };

  const createAttemptResponseCallback = (
    attempt: PinnedTransportAttempt,
  ): ((response: unknown) => void) => (response) => {
    if (attempt.responseDelivered) {
      containResponse(response);
      return;
    }
    // Only one response may enter the bounded pump. Native or mocked
    // duplicate callbacks are destroyed by the separate iterative sink.
    attempt.responseDelivered = true;
    enqueue({ kind: 'response', attempt, response });
  };

  const createAttemptRequestListeners = (
    attempt: PinnedTransportAttempt,
  ): PinnedTransportAttempt['requestListeners'] => [
    ['error', () => {
      if (attempt.requestTerminalDelivered) return;
      attempt.requestTerminalDelivered = true;
      enqueue({
        kind: 'request-terminal',
        attempt,
        notification: 'onRequestError',
      });
    }],
    ['close', () => {
      if (attempt.requestTerminalDelivered) return;
      attempt.requestTerminalDelivered = true;
      enqueue({
        kind: 'request-terminal',
        attempt,
        notification: 'onRequestClose',
      });
    }],
  ];

  const createAttemptRequest = (
    current: PinnedTransportAuthority,
    attempt: PinnedTransportAttempt,
    snapshot: readonly ProjectTemplateArtifactDnsAnswerSnapshot[],
  ): void => {
    const url = attempt.targetUrl;
    if (url === undefined) {
      terminate(current, 'onInvalidResponse');
      return;
    }
    const hostname = url.hostname;
    const path = `${url.pathname}${url.search}`;
    attempt.targetUrl = undefined;
    attempt.secrets.hostname = hostname;
    attempt.secrets.snapshot = snapshot;
    // The lookup retains only the clearable generation holder. It never
    // closes over the hostname, URL, snapshot, attempt, or transport.
    const pinnedLookup = createRevocablePinnedLookup(attempt.secrets);
    const responseCallback = createAttemptResponseCallback(attempt);
    let request: ClientRequest;
    try {
      request = httpsRequest({
        agent: false,
        protocol: 'https:',
        hostname,
        servername: hostname,
        port: 443,
        method: 'GET',
        path,
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          Host: hostname,
          'User-Agent': 'takt-project-template',
        },
        lookup: pinnedLookup,
      }, responseCallback);
    } catch {
      terminate(current, 'onInvalidResponse');
      return;
    }
    const requestDestroy = findPinnedMethod(request, 'destroy');
    const requestEnd = findPinnedMethod(request, 'end');
    if (
      isStopped(current)
      || current.activeAttempt !== attempt
      || holder.current !== current
      || requestDestroy === undefined
      || requestEnd === undefined
    ) {
      destroyRequest(request, requestDestroy);
      if (
        !isStopped(current)
        && current.activeAttempt === attempt
      ) {
        terminate(current, 'onInvalidResponse');
      }
      return;
    }
    attempt.request = request;
    attempt.requestDestroy = requestDestroy;
    attempt.requestEnd = requestEnd;
    const listeners = createAttemptRequestListeners(attempt);
    attempt.requestListeners = listeners;
    try {
      for (const [event, listener] of listeners) {
        EventEmitter.prototype.on.call(request, event, listener);
        if (
          isStopped(current)
          || current.activeAttempt !== attempt
        ) {
          try {
            EventEmitter.prototype.removeListener.call(
              request,
              event,
              listener,
            );
          } catch {
            // Terminal request ownership is already detached.
          }
          removeRequestListeners(request, listeners);
          return;
        }
      }
      Reflect.apply(requestEnd, request, []);
    } catch {
      terminate(current, 'onInvalidResponse');
    }
  };

  const settleNonRedirectResponse = (
    current: PinnedTransportAuthority,
    attempt: PinnedTransportAttempt,
    response: unknown,
    statusCode: number,
  ): void => {
    current.phase = 'terminal';
    current.initialTargetUrl = undefined;
    current.release();
    const detached = detachAttempt(current, attempt);
    const ownedState = current.state;
    current.state = undefined;
    const pendingEvents = current.pumpQueue.splice(0);
    const cleaned = detached !== undefined
      && cleanDetachedAttempt(detached, response);
    try {
      ownedState?.dispose();
    } catch {
      // Capability revocation is complete before disposal can re-enter.
    }
    clearPendingEvents(pendingEvents);
    if (isDisposed(current)) return;
    if (!cleaned) {
      invoke('onResponseError');
      return;
    }
    // A consumer exception cannot revive transport authority and is not a
    // second transport event.
    invoke('onResponse', [statusCode]);
  };

  const acceptPausedBody = (
    current: PinnedTransportAuthority,
    attempt: PinnedTransportAttempt,
    response: unknown,
  ): void => {
    if (!isPinnedReadable(response)) {
      terminate(current, 'onInvalidResponse', response);
      return;
    }
    const pause = findPinnedMethod(response, 'pause');
    const resume = findPinnedMethod(response, 'resume');
    const destroy = findPinnedMethod(response, 'destroy');
    if (pause === undefined || resume === undefined || destroy === undefined) {
      terminate(current, 'onInvalidResponse', response);
      return;
    }
    const detached = detachAttempt(current, attempt);
    if (detached === undefined) {
      containResponse(response);
      terminate(current, 'onInvalidResponse');
      return;
    }
    const listenerToken: PinnedTransportBodyListenerToken = {
      active: true,
    };
    listenerToken.dispatch = (event, chunk) => {
      enqueue({
        kind: 'body-event',
        token: listenerToken,
        event,
        chunk: event === 'data' ? chunk : undefined,
      });
    };
    const body: PinnedTransportBody = {
      listenerToken,
      response,
      pause,
      resume,
      destroy,
      responseListeners: [],
      request: detached.request,
      requestDestroy: detached.requestDestroy,
      requestListeners: detached.listeners,
    };
    current.phase = 'accepting-body';
    current.body = body;
    try {
      Reflect.apply(pause, response, []);
    } catch {
      terminate(current, 'onResponseError');
      return;
    }
    if (
      current.phase !== 'accepting-body'
      || current.body !== body
    ) {
      return;
    }
    const events = [
      'data',
      'end',
      'aborted',
      'error',
      'close',
    ] as const satisfies readonly PinnedTransportBodyEventKind[];
    const listeners = events.map((event) => [
      event,
      createPinnedBodyListener(listenerToken, event),
    ] as const);
    for (const [event, listener] of listeners) {
      try {
        EventEmitter.prototype.on.call(response, event, listener);
      } catch {
        terminate(current, 'onResponseError');
        return;
      }
      if (
        current.phase !== 'accepting-body'
        || current.body !== body
      ) {
        try {
          EventEmitter.prototype.removeListener.call(
            response,
            event,
            listener,
          );
        } catch {
          // Disposal has already revoked the candidate authority.
        }
        return;
      }
      body.responseListeners = Object.freeze([
        ...body.responseListeners,
        [event, listener] as const,
      ]);
    }
    if (!removeRequestListeners(body.request, body.requestListeners)) {
      terminate(current, 'onResponseError');
      return;
    }
    body.requestListeners = [];
    const ownedState = current.state;
    current.state = undefined;
    try {
      ownedState?.dispose();
    } catch {
      terminate(current, 'onResponseError');
      return;
    }
    if (
      current.phase !== 'accepting-body'
      || current.body !== body
    ) {
      return;
    }
    current.phase = 'body-paused';
    if (!invoke('onResponse', [200])) {
      terminate(current, 'onResponseError');
    }
  };

  const processResponse = (
    current: PinnedTransportAuthority,
    attempt: PinnedTransportAttempt,
    response: unknown,
  ): void => {
    if (
      current.activeAttempt !== attempt
      || attempt.responseSeen
      || isStopped(current)
    ) {
      containResponse(response);
      return;
    }
    attempt.responseSeen = true;
    const rawStatus = findPinnedData(response, 'statusCode');
    if (
      typeof rawStatus !== 'number'
      || !Number.isSafeInteger(rawStatus)
      || rawStatus < 100
      || rawStatus > 599
    ) {
      terminate(current, 'onInvalidResponse', response);
      return;
    }
    if (rawStatus === 200) {
      acceptPausedBody(current, attempt, response);
      return;
    }
    if (!REDIRECT_STATUSES.has(rawStatus)) {
      settleNonRedirectResponse(current, attempt, response, rawStatus);
      return;
    }
    const location = snapshotPinnedRedirectLocation(response);
    if (location === undefined) {
      terminate(current, 'onInvalidResponse', response);
      return;
    }
    const nextTargetUrl = moveNextHop(current, rawStatus, location);
    if (nextTargetUrl === undefined) {
      terminate(current, 'onInvalidResponse', response);
      return;
    }
    // The next hop is already owned by the transport, but cannot start until
    // every event-capable resource from this generation is detached and
    // successfully destroyed.
    const detached = detachAttempt(current, attempt);
    if (detached === undefined) {
      containResponse(response);
      terminate(current, 'onInvalidResponse');
      return;
    }
    const cleaned = cleanDetachedAttempt(detached, response);
    if (
      isStopped(current)
      || holder.current !== current
    ) {
      return;
    }
    if (!cleaned) {
      terminate(current, 'onInvalidResponse');
      return;
    }
    enqueue({ kind: 'begin', targetUrl: nextTargetUrl });
  };

  const settleBody = (
    current: PinnedTransportAuthority,
    body: PinnedTransportBody,
    notification:
      | 'onEnd'
      | 'onResponseAborted'
      | 'onResponseError'
      | 'onResponseClose',
    destroyResources: boolean,
  ): void => {
    if (current.body !== body || isStopped(current)) return;
    current.phase = 'terminal';
    current.release();
    const detached = detachBody(current, body);
    const pendingEvents = current.pumpQueue.splice(0);
    if (detached !== undefined) {
      if (destroyResources) {
        cleanDetachedBody(detached);
      } else {
        releaseDetachedBody(detached);
      }
    }
    clearPendingEvents(pendingEvents);
    if (isDisposed(current)) return;
    invoke(notification);
  };

  const processBodyEvent = (
    current: PinnedTransportAuthority,
    event: Extract<PinnedTransportPumpEvent, { kind: 'body-event' }>,
  ): void => {
    const body = current.body;
    if (
      body === undefined
      || body.listenerToken !== event.token
      || !event.token.active
    ) {
      event.chunk = undefined;
      return;
    }
    if (event.event === 'data') {
      if (current.phase !== 'body-streaming') {
        event.chunk = undefined;
        terminate(current, 'onResponseError');
        return;
      }
      let chunk = event.chunk;
      event.chunk = undefined;
      const delivered = invoke('onData', [chunk]);
      chunk = undefined;
      if (!delivered && !isStopped(current)) {
        terminate(current, 'onResponseError');
      }
      return;
    }
    event.chunk = undefined;
    if (event.event === 'end') {
      settleBody(current, body, 'onEnd', false);
      return;
    }
    const notification = event.event === 'aborted'
      ? 'onResponseAborted'
      : event.event === 'error'
        ? 'onResponseError'
        : 'onResponseClose';
    settleBody(current, body, notification, true);
  };

  const processPumpEvent = (
    current: PinnedTransportAuthority,
    event: PinnedTransportPumpEvent,
  ): void => {
    if (isStopped(current)) {
      if (event.kind === 'response') containResponse(event.response);
      if (event.kind === 'body-event') event.chunk = undefined;
      return;
    }
    if (event.kind === 'begin') {
      beginAttempt(current, event.targetUrl);
      return;
    }
    if (event.kind === 'dns') {
      if (
        current.activeAttempt !== event.attempt
        || event.attempt.dnsSettled
      ) {
        return;
      }
      event.attempt.dnsSettled = true;
      if (event.snapshot === undefined) {
        terminate(current, 'onDnsRejected');
        return;
      }
      createAttemptRequest(current, event.attempt, event.snapshot);
      return;
    }
    if (event.kind === 'response') {
      processResponse(current, event.attempt, event.response);
      return;
    }
    if (event.kind === 'body-event') {
      processBodyEvent(current, event);
      return;
    }
    if (current.activeAttempt === event.attempt) {
      terminate(current, event.notification);
    }
  };

  drainPump = (): void => {
    if (authority.draining) return;
    authority.draining = true;
    try {
      while (authority.pumpQueue.length > 0) {
        const event = authority.pumpQueue.shift();
        if (event !== undefined) processPumpEvent(authority, event);
      }
    } finally {
      authority.draining = false;
    }
  };

  const facade = Object.freeze<ProjectTemplateArtifactPinnedTransport>({
    start(this: ProjectTemplateArtifactPinnedTransport): void {
      const current = pinnedTransportAuthorities.get(this);
      if (current === undefined || isStopped(current)) {
        throw invalidArgument();
      }
      if (current.phase !== 'idle') return;
      current.phase = 'redirect-attempt';
      const initialTarget = current.initialTargetUrl;
      current.initialTargetUrl = undefined;
      if (initialTarget === undefined) {
        terminate(current, 'onDnsRejected');
        return;
      }
      enqueue({ kind: 'begin', targetUrl: initialTarget });
    },
    pause(this: ProjectTemplateArtifactPinnedTransport): void {
      const current = pinnedTransportAuthorities.get(this);
      if (
        current === undefined
        || (
          current.phase !== 'body-paused'
          && current.phase !== 'body-streaming'
        )
        || current.body === undefined
      ) {
        throw invalidArgument();
      }
      if (current.phase === 'body-paused') return;
      const body = current.body;
      const response = body.response;
      const pause = body.pause;
      current.phase = 'body-paused';
      if (response === undefined || pause === undefined) {
        terminate(current, 'onResponseError');
        throw invalidArgument();
      }
      try {
        Reflect.apply(pause, response, []);
      } catch {
        terminate(current, 'onResponseError');
        throw invalidArgument();
      }
    },
    resume(this: ProjectTemplateArtifactPinnedTransport): void {
      const current = pinnedTransportAuthorities.get(this);
      if (
        current === undefined
        || (
          current.phase !== 'body-paused'
          && current.phase !== 'body-streaming'
        )
        || current.body === undefined
      ) {
        throw invalidArgument();
      }
      if (current.phase === 'body-streaming') return;
      const body = current.body;
      const response = body.response;
      const resume = body.resume;
      current.phase = 'body-streaming';
      if (response === undefined || resume === undefined) {
        terminate(current, 'onResponseError');
        throw invalidArgument();
      }
      try {
        Reflect.apply(resume, response, []);
      } catch {
        terminate(current, 'onResponseError');
        throw invalidArgument();
      }
    },
    destroy(this: ProjectTemplateArtifactPinnedTransport): void {
      const current = pinnedTransportAuthorities.get(this);
      if (current === undefined || current.phase === 'disposed') {
        throw invalidArgument();
      }
      terminate(current);
    },
    dispose(this: ProjectTemplateArtifactPinnedTransport): void {
      if (!pinnedTransportFacades.has(this)) throw invalidArgument();
      const current = pinnedTransportAuthorities.get(this);
      if (current === undefined || current.phase === 'disposed') return;
      current.phase = 'disposed';
      current.initialTargetUrl = undefined;
      current.release();
      const detached = detachAttempt(current);
      const detachedBody = detachBody(current);
      const ownedState = current.state;
      current.state = undefined;
      const pendingEvents = current.pumpQueue.splice(0);
      pinnedTransportAuthorities.delete(this);
      if (detached !== undefined) cleanDetachedAttempt(detached);
      if (detachedBody !== undefined) cleanDetachedBody(detachedBody);
      clearPendingEvents(pendingEvents);
      try {
        ownedState?.dispose();
      } catch {
        // Explicit disposal remains authoritative.
      }
    },
  });
  pinnedTransportFacades.add(facade);
  pinnedTransportAuthorities.set(facade, authority);
  return facade;
}
