Review the code diff.

{review-common}

Coding review focus:
- Look for implementation bugs, regressions in existing behavior, security risks, and missing tests
- If the diff adds or changes a shared helper, normalizer, builder, or adapter, verify that existing equivalent branches apply the same contract
- If types, schemas, validators, or resolvers changed, verify that the corresponding contracts are updated in the same change
- For values resolved or composed across multiple layers, trace the path from the real entry point through validation, not only standalone normalization
- If a non-execution entry displays, validates, or explains the same value, compare whether it resolves through the same normalized input, override order, and resolver as the primary execution path
- When tests exist, verify that they cover the original requirement's branch conditions such as unset, set, invalid value, override, inherited, non-inherited, and unsupported target, not only value presence
- For diffs involving side effects or state changes, trace entry, normal completion, early exit, exception, and cleanup paths
- Include only issues caused by the current diff that the user should fix
- For each finding, include location, impact, and fix direction
- Do not report unsupported speculation, preference-only changes, or unrelated pre-existing issues
