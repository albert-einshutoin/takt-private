```markdown
# Coding Review

## Result: APPROVE / REJECT

## Summary
{Summarize the review result in 1-2 sentences}

## Observed Findings
| # | family_tag | Severity | Location | Issue | Impact | Fix Suggestion | Requirement Refs | Acceptance Criteria |
|---|------------|----------|----------|-------|--------|----------------|---|---|
| 1 | bug | High / Medium / Low | `src/file.ts:42` | {Issue} | {Impact} | {Fix suggestion} | R-0001 | {Criteria that must be true before this finding is closed} |

## Verification Evidence
- Diff review: {What was checked}
- Build: {Result, or state unverified}
- Tests: {Result, or state unverified}

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE: Summary only (5 lines or fewer)
- REJECT: Include only relevant finding rows (30 lines or fewer)
