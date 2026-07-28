```markdown
# Fix Report

> Keep evidence concise and bounded. Never include secrets, credentials, tokens, full prompts, raw decision text, verbatim private source text, or unbounded logs. Record stable IDs, paths, commands, and redacted summaries instead.

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
| Type | Result | Evidence |
|------|--------|----------|
| {Build / Test / Lint / Security / Other} | {Passed / Failed / Not run} | {Command, path, or concise result} |

## Family Coverage
| family_tag | Covered Branches | Test | Status and Reason |
|------------|------------------|------|-------------------|
| {tag} | {Branches} | {file:line or "None"} | {Covered / Missing: concise reason} |

## Decision and Resume Continuity
| decision_id | State | Why Blocked | What Must Be Decided or Safe Summary | How to Resume / Evidence |
|-------------|-------|-------------|--------------------------------------|--------------------------|
| {Stable ID or "None"} | {Waiting / Answered / Applied} | {Concise reason human judgment was required} | {Decision required, or a redacted answer summary} | {Next safe action plus event ID, artifact path, commit, or test proving continuity} |
```
