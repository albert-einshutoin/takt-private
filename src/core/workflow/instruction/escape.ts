/**
 * Template escaping and placeholder replacement utilities
 *
 * Used by instruction builders to process resolved instruction content.
 *
 * escapeTemplateChars is re-exported from faceted-prompting.
 * replaceTemplatePlaceholders is TAKT-specific and stays here.
 */

import type { WorkflowStep } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import { escapeTemplateChars } from 'faceted-prompting';

export { escapeTemplateChars } from 'faceted-prompting';

// String replacement patterns interpret `$&`, `$'`, and "$`" specially. A
// callback keeps arbitrary task, response, and report content byte-for-byte literal.
const literalReplacement = (value: string): (() => string) => () => value;

/**
 * Replace supported placeholders in the resolved instruction body.
 */
export function replaceTemplatePlaceholders(
  template: string,
  step: WorkflowStep,
  context: InstructionContext,
): string {
  let result = template;

  result = result.replace(/\{(context|structured|effect):([^}]+)\}/g, (_match, root: string, ref: string) => {
    if (!context.workflowState) {
      throw new Error(`Workflow state is required for "{${root}:${ref}}" interpolation`);
    }
    const value = resolveWorkflowStateReference(`${root}.${ref.replace(/:/g, '.')}`, context.workflowState);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return escapeTemplateChars(String(value));
    }
    if (root !== 'context') {
      throw new Error(`Instruction interpolation requires scalar value for "${root}:${ref}"`);
    }
    return escapeTemplateChars(JSON.stringify(value, null, 2));
  });

  // Replace {task}
  result = result.replace(/\{task\}/g, literalReplacement(escapeTemplateChars(context.task)));

  // Replace {iteration}, {max_steps}, and {step_iteration}
  result = result.replace(/\{iteration\}/g, String(context.iteration));
  result = result.replace(/\{max_steps\}/g, String(context.maxSteps));
  result = result.replace(/\{step_iteration\}/g, String(context.stepIteration));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousResponseEscapedText !== undefined) {
      result = result.replace(
        /\{previous_response\}/g,
        literalReplacement(context.previousResponseEscapedText),
      );
    } else if (context.previousResponseText !== undefined) {
      result = result.replace(
        /\{previous_response\}/g,
        literalReplacement(escapeTemplateChars(context.previousResponseText)),
      );
    } else if (context.previousOutput) {
      result = result.replace(
        /\{previous_response\}/g,
        literalReplacement(escapeTemplateChars(context.previousOutput.content)),
      );
    } else {
      result = result.replace(/\{previous_response\}/g, '');
    }
  }

  // Replace {user_inputs}
  const userInputsStr = context.userInputs.join('\n');
  result = result.replace(
    /\{user_inputs\}/g,
    literalReplacement(escapeTemplateChars(userInputsStr)),
  );

  // Replace {report_dir}
  if (context.reportDir) {
    result = result.replace(/\{report_dir\}/g, literalReplacement(context.reportDir));
  }

  result = result.replace(/\{current_report\}/g, literalReplacement(context.currentReport ?? ''));
  result = result.replace(/\{previous_report\}/g, literalReplacement(context.previousReport ?? ''));
  result = result.replace(/\{report_history\}/g, literalReplacement(context.reportHistory ?? ''));
  result = result.replace(/\{peer_reports\}/g, literalReplacement(context.peerReports ?? ''));

  // Replace {report:filename} with reportDir/filename
  if (context.reportDir) {
    result = result.replace(/\{report:([^}]+)\}/g, (_match, filename: string) => {
      return `${context.reportDir}/${filename}`;
    });
  }

  return result;
}
