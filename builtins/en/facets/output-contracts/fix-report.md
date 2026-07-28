```markdown
# Fix Report

> Keep evidence concise and bounded. Never include secrets, credentials, tokens, full prompts, raw decision text, verbatim private source text, or unbounded logs. Record stable IDs, paths, redacted command names with safe arguments, and sanitized summaries instead.

## Summary
{Concise summary of the result, changes, remaining risk, and evidence}

## Addressed Findings
| Finding ID | Change | Status |
|------------|--------|--------|
| {ID} | {Concise summary of the change} | {Fixed / Disputed} |

## Remaining Findings
| Finding ID | Why It Remains | Required Action |
|------------|----------------|-----------------|
| {ID or "None"} | {Bounded reason} | {Next action or decision needed} |

## Verification
> Use only a redacted command name and safe arguments. Never include environment variables, secret-bearing arguments, raw stdout/stderr, or decision answers in verification evidence.

| Type | Result | Evidence |
|------|--------|----------|
| {Build / Test / Lint / Security / Other} | {Passed / Failed / Not run} | {Redacted command name with safe arguments, artifact path, or bounded result summary} |

## Family Coverage
| family_tag | Covered Branches | Test | Status and Reason |
|------------|------------------|------|-------------------|
| {tag} | {Branches} | {file:line or "None"} | {Covered / Missing: concise reason} |

## Decision and Resume Continuity
> Use only decision_id and a sanitized, bounded summary of non-confidential Why / What / How. Never include the raw decision request, raw decision answer, or private source text.

| decision_id | State | Why Blocked | What Must Be Decided or Safe Summary | How to Resume / Evidence |
|-------------|-------|-------------|--------------------------------------|--------------------------|
| {Stable ID or "None"} | {Waiting / Answered / Applied} | {Sanitized, bounded, non-confidential reason human judgment was required} | {Sanitized, bounded, non-confidential decision summary} | {Next safe action plus event ID, artifact path, commit, or test proving continuity} |
```
