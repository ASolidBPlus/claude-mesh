/**
 * ONE SCANNER FOR THE STRUCTURAL TESTS.
 *
 * Several tests ask questions about the SOURCE rather than about behaviour —
 * "does this function have exactly one call site", "does this body mention
 * that helper" — because the property they defend has no observable: a second
 * call site is a delivery loop that needs two peerings to appear, and a
 * captured reference is a caller no test drives.
 *
 * Those tests were each carrying their own regex scanner. They agreed on what
 * to do and differed on what they had remembered to guard, which is how two
 * copies of one idea drift: #170 took THREE rounds to close alias, control and
 * export evasions in one file, while the other file closed a different subset.
 * This is that scanner, once, with its own pins.
 *
 * WHAT IT UNDERSTANDS: line comments, block comments, single- and
 * double-quoted strings, template literals including `${}` interpolation, and
 * backslash escapes in all of them.
 *
 * WHAT IT DOES NOT: regex literals are scanned as ordinary code. That is safe
 * for `//` (an unescaped `/` ends a regex, so `//` cannot appear inside one
 * outside a character class) and it is a real limit for the exotic case
 * `/[//]/`. Pinned in the helper's own tests as a KNOWN limitation rather than
 * left for someone to discover — a scanner whose limits are undocumented gets
 * trusted past them.
 */

/** Which literal context a character sits in. */
type Ctx = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';

interface Masked {
  /** Same length as the input. Comment bodies blanked; string CONTENTS blanked. */
  code: string;
  /** Same length as the input. Comment bodies blanked; strings left intact. */
  noComments: string;
}

/**
 * One pass, producing both views. Blanking rather than deleting keeps every
 * offset and line number identical to the original, so a failure message
 * points at the real place.
 *
 * Newlines are preserved inside blanked regions for the same reason.
 */
function mask(src: string): Masked {
  const code: string[] = [];
  const noComments: string[] = [];
  let ctx: Ctx = 'code';
  // Template literals nest: `${ `inner` }`. A stack, not a boolean.
  const templateDepth: number[] = [];
  let braceDepthInTemplate = 0;

  const push = (ch: string, inCode: boolean, inNoComments: boolean) => {
    const blank = ch === '\n' ? '\n' : ' ';
    code.push(inCode ? ch : blank);
    noComments.push(inNoComments ? ch : blank);
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];

    switch (ctx) {
      case 'code':
        if (ch === '/' && next === '/') { ctx = 'line-comment'; push(ch, false, false); break; }
        if (ch === '/' && next === '*') { ctx = 'block-comment'; push(ch, false, false); break; }
        if (ch === "'") { ctx = 'single'; push(ch, true, true); break; }
        if (ch === '"') { ctx = 'double'; push(ch, true, true); break; }
        if (ch === '`') { ctx = 'template'; templateDepth.push(braceDepthInTemplate); push(ch, true, true); break; }
        push(ch, true, true);
        break;

      case 'line-comment':
        if (ch === '\n') { ctx = 'code'; push(ch, true, true); break; }
        push(ch, false, false);
        break;

      case 'block-comment':
        if (ch === '*' && next === '/') { push(ch, false, false); push('/', false, false); i++; ctx = 'code'; break; }
        push(ch, false, false);
        break;

      case 'single':
      case 'double':
        if (ch === '\\') { push(ch, false, true); if (i + 1 < src.length) { push(src[i + 1]!, false, true); i++; } break; }
        if ((ctx === 'single' && ch === "'") || (ctx === 'double' && ch === '"')) { ctx = 'code'; push(ch, true, true); break; }
        // The CONTENT is blanked in `code` and kept in `noComments`: a `//`
        // inside a string is not a comment, and a NAME inside a string is not
        // a reference.
        push(ch, false, true);
        break;

      case 'template':
        if (ch === '\\') { push(ch, false, true); if (i + 1 < src.length) { push(src[i + 1]!, false, true); i++; } break; }
        if (ch === '`') { ctx = 'code'; templateDepth.pop(); push(ch, true, true); break; }
        if (ch === '$' && next === '{') {
          // Interpolation is CODE. Track the brace so the closing one returns
          // to the template rather than to code.
          push(ch, true, true); push('{', true, true); i++;
          ctx = 'code'; braceDepthInTemplate++;
          break;
        }
        push(ch, false, true);
        break;
    }

    // Leaving an interpolation returns to the enclosing template.
    if (ctx === 'code' && braceDepthInTemplate > 0 && ch === '}' && templateDepth.length > 0) {
      braceDepthInTemplate--;
      ctx = 'template';
    }
  }

  return { code: code.join(''), noComments: noComments.join('') };
}

/**
 * Comments blanked; strings LEFT INTACT.
 *
 * The precondition every hand-rolled version had and none pinned: a `//`
 * inside a string literal must not take the rest of that line with it. The
 * regex versions (`replace(/\/\/.*$/gm, '')`) did exactly that.
 */
export function stripComments(src: string): string {
  return mask(src).noComments;
}

/**
 * Comments AND string contents blanked — "the code, and only the code".
 *
 * This is the view the reference questions below use: a name inside a string
 * or a comment is not a call, not a capture and not a definition, and counting
 * it would measure how much was WRITTEN about a rule rather than whether the
 * code follows it.
 */
export function codeOnly(src: string): string {
  return mask(src).code;
}

/** `function name(` and `export [default] [async] function name(`, in code. */
export function definitions(src: string, name: string): number {
  const re = new RegExp(`(?:^|[^.\\w])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  return [...codeOnly(src).matchAll(re)].length;
}

/**
 * Occurrences of `name(` that are not a definition.
 *
 * A PRECEDING `.` DISQUALIFIES IT: `obj.target()` is a method on something
 * else, not a call to the free function this scanner is asked about. Counting
 * it would make an unrelated property name inflate a single-call-site claim —
 * found by the helper's own test, which is the argument for the helper.
 */
export function callSites(src: string, name: string): number {
  const all = [...codeOnly(src).matchAll(new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g'))].length;
  return all - definitions(src, name);
}

/**
 * Mentions of the name NOT followed by `(` — the alias evasion.
 *
 * `const h = fn; … h(x)` adds a caller that `callSites` cannot see, because the
 * call is spelled `h(`. #170 took three rounds to find this; it is the reason
 * a single-call-site claim needs both counts.
 */
export function nonCallMentions(src: string, name: string): number {
  // Same `.` exclusion as callSites: `obj.target` is a property, not a capture
  // of the free function.
  return [...codeOnly(src).matchAll(new RegExp(`(?<![.\\w])${name}\\b(?!\\s*\\()`, 'g'))].length;
}

/** Is the definition exported? A single unexported definition is what makes
 *  "nothing outside this file can reach it" true. */
export function isExported(src: string, name: string): boolean {
  return new RegExp(`\\bexport\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(codeOnly(src));
}

/**
 * The body of a TOP-LEVEL `function name(...)`.
 *
 * TWO INDEPENDENT SIGNALS, because each alone has a failure mode this file
 * exists to remove:
 *
 *   the END is the first `}` at COLUMN 0 after the definition. Safe here in a
 *   way the hand-rolled versions were not: it runs on the CODE-ONLY view,
 *   where a template literal's text is blanked, so the `\n}` that used to end
 *   a slice three lines early cannot occur inside one.
 *
 *   the RESULT is then brace-BALANCED, and an imbalance THROWS. That is the
 *   backstop for the column-0 rule's own assumption (a top-level function
 *   closes at column 0) rather than a restatement of it.
 *
 * Opening-brace scanning was tried first and is WRONG for TypeScript: a return
 * type annotation like `): { alias: string; id: string }[] {` puts a brace
 * before the body's, so matching from the first `{` returns the return type.
 * Found against a real file after the fixtures passed — which is why the
 * fixtures below now include that signature.
 *
 * Returns the CODE-ONLY view: a mention inside a string or comment in the body
 * is not a reference.
 */
export function bodyOf(src: string, name: string): string {
  const code = codeOnly(src);
  const defRe = new RegExp(`(?:^|[^.\\w])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = defRe.exec(code);
  if (m === null) throw new Error(`source-scan: no definition of ${name}`);
  const start = m.index + (m[0]!.startsWith('function') || m[0]!.startsWith('export') ? 0 : 1);

  const end = code.indexOf('\n}', start);
  if (end === -1) throw new Error(`source-scan: no column-0 close for ${name} — refusing to return a truncated slice`);
  const body = code.slice(start, end + 2);

  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 0) {
    throw new Error(`source-scan: unbalanced body for ${name} (depth ${depth}) — refusing to return a truncated slice`);
  }
  return body;
}
