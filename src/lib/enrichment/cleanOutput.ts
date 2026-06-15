/**
 * LLM output cleaning utilities.
 *
 * LLMs frequently wrap their answers in markdown code fences, add a
 * "Sure, here is..." preamble, or emit <think> blocks. When those land
 * verbatim in a spreadsheet cell the enrichment looks broken. These
 * helpers normalise model output into the clean value a cell should hold.
 */

/** Strip <think>/<thinking> reasoning blocks (reasoning models). */
export const stripThinking = (input: string): string => {
  if (!input) return input;
  return input
    .replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    // Unterminated thinking block: drop everything up to the closing tag.
    .replace(/[\s\S]*<\/think(?:ing)?>/i, '')
    .trim();
};

/**
 * Remove a single wrapping markdown code fence, e.g.
 * ```json\n{...}\n```  ->  {...}
 * Leaves inline/multi-fence content untouched so legitimately fenced
 * scraped markdown is preserved.
 */
export const stripCodeFence = (input: string): string => {
  if (!input) return input;
  const trimmed = input.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/;
  const match = trimmed.match(fence);
  return match ? match[1].trim() : trimmed;
};

/**
 * General-purpose cell value cleaner: drop reasoning blocks, unwrap a
 * single code fence, and collapse runaway blank lines. Safe to apply to
 * any AI text result.
 */
export const cleanLLMOutput = (input: string): string => {
  if (!input || typeof input !== 'string') return input ?? '';
  let out = stripThinking(input);
  out = stripCodeFence(out);
  out = out.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return out;
};

/**
 * Extract a JSON object/array from a model response that may be wrapped in
 * a code fence or surrounded by prose. Returns the parsed value, or throws
 * if no valid JSON can be recovered.
 */
export const extractJson = <T = unknown>(input: string): T => {
  const cleaned = stripCodeFence(stripThinking(input));
  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through to substring extraction */
  }
  // Find the first balanced {...} or [...] span.
  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  const start =
    firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
  if (start === -1) throw new Error('No JSON found in response');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error('No balanced JSON found in response');
};
