// Classification and semantic merge must reject the same nesting boundary.
// A shared limit prevents YAML from passing cheap inspection and exhausting
// the JavaScript stack later during rule-aware validation.
export const MAX_PROJECT_TEMPLATE_YAML_DEPTH = 32;
