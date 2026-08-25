const GITHUB_OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Portable GitHub grammar. Source parsing may normalize its casing later. */
export function isCanonicalGithubOwner(owner: unknown): owner is string {
  return (
    typeof owner === 'string'
    && GITHUB_OWNER_PATTERN.test(owner)
    && !owner.includes('--')
  );
}

export function isCanonicalGithubRepository(repo: unknown): repo is string {
  return (
    typeof repo === 'string'
    && GITHUB_REPOSITORY_PATTERN.test(repo)
    && repo !== '.'
    && repo !== '..'
    && !repo.toLowerCase().endsWith('.git')
  );
}

export function isCanonicalGithubRepositoryCoordinates(
  owner: unknown,
  repo: unknown,
): boolean {
  return (
    isCanonicalGithubOwner(owner)
    && isCanonicalGithubRepository(repo)
    && owner === owner.toLowerCase()
    && repo === repo.toLowerCase()
  );
}
