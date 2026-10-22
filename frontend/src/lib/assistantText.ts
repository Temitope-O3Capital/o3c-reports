import { fixSeparators } from './speech'

/**
 * Making the answer on screen look like the answer we asked for.
 *
 * The system prompt says "Plain text only. No markdown, no bold, no bullet
 * symbols other than a simple hyphen." It is followed loosely: 4 of the first 55
 * answers staff received contained `**`, and the panel renders content in a
 * pre-wrap div, so those asterisks are shown literally. "**Igwilo Jennifer** with
 * NGN 5,953,682,018.89" is what the person actually reads.
 *
 * A style instruction is a request. This is the guarantee — the same reasoning as
 * fixSeparators, which repairs the narrow no-break space the model uses as a
 * thousands separator. Both exist because the model is inconsistent rather than
 * incapable: it writes commas in one answer and spaces in the next, plain text in
 * one and bold in the next, and no amount of prompt will make that reliable.
 *
 * Deliberately NOT a markdown renderer. Rendering the model's markdown would
 * invite it to use more, and the answers are meant to be short prose with the
 * occasional hyphen bullet. This only removes the marks it was asked not to emit.
 */

/** Bold and italic markers around text, left in place of the markup. */
function stripEmphasis(text: string): string {
  return text
    // **bold** and __bold__. Non-greedy, and must contain something.
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // *italic* and _italic_, but NOT a lone asterisk and not snake_case: the
    // opening mark must be followed by a non-space and preceded by a boundary,
    // or "fee_income_ngn" would lose its middle.
    .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_(\S[^_]*?)_(?=[\s).,;:!?]|$)/g, '$1$2')
}

/** Headings and code fences the model occasionally reaches for. */
function stripBlockMarks(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')     // ## Heading
    .replace(/^\s*```.*$/gm, '')     // fence lines, keeping the content between
    .replace(/`([^`]+)`/g, '$1')     // inline code ticks
}

/**
 * Everything the panel should do to an answer before showing it.
 *
 * Order matters: emphasis is stripped before separators are repaired, so a figure
 * written as "**1 373**" still gets its comma.
 */
export function forDisplay(text: string): string {
  if (!text) return text
  return fixSeparators(stripBlockMarks(stripEmphasis(text)))
}
