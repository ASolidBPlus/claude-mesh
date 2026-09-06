import { describe, it, expect } from 'bun:test';
import {
  stripComments, codeOnly, definitions, callSites, nonCallMentions, isExported, bodyOf,
} from './helpers/source-scan.ts';

// #173 — the scanner the structural tests share, with the pins none of the
// hand-rolled copies had.
//
// Structural tests defend properties that have no observable — a second call
// site is a delivery loop that needs two peerings to appear; a captured
// reference is a caller no test drives. That makes the SCANNER the thing under
// test, and an unpinned scanner is a green that measures its own regexes.
//
// Everything here is a fixture STRING, not a repo file: the questions are about
// the scanner, and a fixture that has to keep agreeing with production source
// is a test that fails for the wrong reason on someone else's commit.

describe('#173 stripComments', () => {
  it('removes line and block comments', () => {
    const out = stripComments('const a = 1; // gone\n/* also gone */ const b = 2;');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
    expect(out).not.toContain('gone');
  });

  // THE PRECONDITION EVERY HAND-ROLLED COPY ASSUMED AND NONE PINNED. The regex
  // version (`replace(/\/\/.*$/gm, '')`) takes the rest of the line with it,
  // so a URL or a path in a string silently deleted real code to its right —
  // and the deletion makes an absence assertion STRICTER, so it passes.
  it('a `//` inside a string is NOT a comment', () => {
    const out = stripComments(`const url = "https://x.example"; const marker = 1;`);
    expect(out).toContain('const marker = 1;');
    expect(out).toContain('https://x.example');
  });

  it('a `//` inside a template literal is NOT a comment', () => {
    const out = stripComments('const t = `see //notes`; const marker = 1;');
    expect(out).toContain('const marker = 1;');
  });

  it('a `//` inside a single-quoted string is NOT a comment', () => {
    const out = stripComments(`const s = 'a // b'; const marker = 1;`);
    expect(out).toContain('const marker = 1;');
  });

  it('an escaped quote does not end the string early', () => {
    const out = stripComments(`const s = 'it\\'s // fine'; const marker = 1;`);
    expect(out).toContain('const marker = 1;');
  });

  it('offsets and line numbers are preserved — blanked, not deleted', () => {
    const src = 'a\n// comment\nb';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(3);
    expect(out.split('\n')[2]).toBe('b');
  });

  // A KNOWN LIMITATION, pinned so it is a decision rather than a discovery.
  // Regex literals are scanned as ordinary code. `//` cannot appear unescaped
  // in a regex (a `/` ends it), so the only casualty is a `/` inside a
  // character class — `/[//]/`. Written down because a scanner whose limits
  // are undocumented gets trusted past them.
  it('KNOWN LIMIT: a `//` inside a regex character class is treated as a comment', () => {
    const out = stripComments('const re = /[//]/; const marker = 1;');
    expect(out).not.toContain('const marker = 1;');
  });
});

describe('#173 codeOnly', () => {
  it('blanks string contents as well as comments', () => {
    const out = codeOnly(`const s = "handleThing"; handleThing();`);
    // The mention inside the string is not a reference.
    expect(out.match(/handleThing/g)?.length).toBe(1);
  });

  it('interpolations inside a template are still code', () => {
    const out = codeOnly('const t = `x ${handleThing()} y`;');
    expect(out).toContain('handleThing()');
  });

  it('nested templates return to the template, not to code', () => {
    const out = codeOnly('const t = `a ${ `b ${c} d` } e`;');
    expect(out).toContain('${');
    expect(out).toContain('c');
    // 'a', 'b', 'd' and 'e' are template TEXT and must be blanked.
    expect(out).not.toContain('a ');
  });
});

describe('#173 definitions / callSites / nonCallMentions / isExported', () => {
  const SRC = `
export function target(x) { return x; }
function other() { target(1); }
const aliased = target;
aliased(2);
// target() in a comment
const s = "target()";
`;

  it('counts one definition and one call', () => {
    expect(definitions(SRC, 'target')).toBe(1);
    expect(callSites(SRC, 'target')).toBe(1);
  });

  it('finds the ALIAS as a non-call mention', () => {
    // `const aliased = target` — the evasion that took #170 three rounds.
    expect(nonCallMentions(SRC, 'target')).toBe(1);
  });

  it('ignores mentions in comments and strings', () => {
    // Both `target` occurrences in the comment and the string are excluded, or
    // the counts above would be higher.
    expect(definitions(SRC, 'target') + callSites(SRC, 'target') + nonCallMentions(SRC, 'target')).toBe(3);
  });

  it('sees the export, and its absence', () => {
    expect(isExported(SRC, 'target')).toBe(true);
    expect(isExported(SRC, 'other')).toBe(false);
  });

  // The three evasions, as one table, because a single-call-site claim needs
  // all three closed and the failure of any one looks identical from outside.
  it('the three evasions of a single-call-site claim', () => {
    const clean = 'function f() {}\nf();';
    expect({ defs: definitions(clean, 'f'), calls: callSites(clean, 'f'), mentions: nonCallMentions(clean, 'f'), exported: isExported(clean, 'f') })
      .toEqual({ defs: 1, calls: 1, mentions: 0, exported: false });

    const aliasEvasion = 'function f() {}\nconst g = f;\ng();';
    expect(nonCallMentions(aliasEvasion, 'f')).toBe(1);

    const exportEvasion = 'export function f() {}\nf();';
    expect(isExported(exportEvasion, 'f')).toBe(true);
    expect(definitions(exportEvasion, 'f')).toBe(1);   // still ONE definition

    const commentEvasion = 'function f() {}\nf();\n// f() again';
    expect(callSites(commentEvasion, 'f')).toBe(1);
  });

  it('a method call `obj.target()` is not a call to the free function', () => {
    expect(callSites('obj.target();', 'target')).toBe(0);
  });
});

describe('#173 bodyOf', () => {
  const SRC = `
function outer() {
  const t = \`
function inner() { forbidden(); }
\`;
  allowed();
}
function after() { forbidden(); }
`;

  // THE TRUNCATION THE HAND-ROLLED VERSION HAD. Slicing to the next column-0
  // `function` stops inside the template literal, three lines early — and every
  // `.not.toContain(...)` around it then passes because the text was never
  // read. Brace matching removes the failure mode instead of detecting it.
  it('does not truncate on a `\\nfunction ` inside a template literal', () => {
    const body = bodyOf(SRC, 'outer');
    expect(body).toContain('allowed()');
    expect(body.trimEnd().endsWith('}')).toBe(true);
  });

  it('stops at the end of the function, not at the end of the file', () => {
    const body = bodyOf(SRC, 'outer');
    // `after()`'s body is a different function and must not be included, or an
    // absence assertion would be answered by the wrong region.
    expect(body).not.toContain('function after');
  });

  it('template TEXT inside the body is not searchable — only code is', () => {
    // `forbidden()` appears inside the template literal, which is text. A
    // structural absence check asks about CODE.
    expect(bodyOf(SRC, 'outer')).not.toContain('forbidden()');
  });

  // TWO REFUSALS, not one, because the two signals fail in different ways and
  // a test that accepted either message would not know which fired.
  it('THROWS when there is no column-0 close at all', () => {
    expect(() => bodyOf('function broken() { if (x) {', 'broken')).toThrow(/no column-0 close/);
  });

  it('THROWS when the column-0 close arrives with braces still open', () => {
    // The backstop for the column-0 rule's own assumption: here it finds a
    // `\n}` but the slice is still one brace deep, so the rule was wrong about
    // where this function ends and the helper refuses rather than returning a
    // short body for an absence check to be answered by.
    const src = 'function broken() {\n  if (x) {\n}\nfunction after() {}\n';
    expect(() => bodyOf(src, 'broken')).toThrow(/unbalanced/);
  });

  it('THROWS when the function is not there at all', () => {
    expect(() => bodyOf('const x = 1;', 'missing')).toThrow(/no definition/);
  });

  // Seat 1's adversarial run on #173: a type parameter sits between the name
  // and the paren, so `function\s+NAME\s*\(` misses it and the consumer is
  // told "no definition" about a definition that is right there — loud, but
  // naming the wrong cause. No repo function takes one today; this is
  // prevention.
  it('a definition with TYPE PARAMETERS is found', () => {
    const src = 'export function shaped<T = {}>(a: T) {\n  marker(a);\n}\n';
    expect(definitions(src, 'shaped')).toBe(1);
    expect(isExported(src, 'shaped')).toBe(true);
    expect(bodyOf(src, 'shaped')).toContain('marker(a)');
  });

  // ...and the limit of that allowance, stated rather than left to surprise:
  // one FLAT `<…>` group. A nested generic stops the `[^>]*` early and the
  // definition is missed — loudly, which is why it is acceptable and recorded.
  it('KNOWN LIMIT: a NESTED generic parameter is not matched', () => {
    const src = 'function deep<T extends Map<string, number>>(a: T) {\n  marker(a);\n}\n';
    expect(definitions(src, 'deep')).toBe(0);
    expect(() => bodyOf(src, 'deep')).toThrow(/no definition/);
  });

  it('handles an exported async definition', () => {
    const body = bodyOf('export async function f(a) {\n  g();\n}\n', 'f');
    expect(body).toContain('g()');
  });

  // THE CASE THAT BIT ME AGAINST A REAL FILE while every fixture passed. A
  // TypeScript return type can contain braces:
  //
  //     ): { alias: string; id: string }[] {
  //
  // so scanning for the first `{` after the parameter list returns the RETURN
  // TYPE, and every absence check is then answered by a few characters of type
  // annotation. Fixtures with simple signatures cannot see it, which is the
  // argument for driving a helper against real source at least once.
  it('a brace in the RETURN TYPE is not mistaken for the body', () => {
    const src = [
      'export function shaped(',
      '  a: number,',
      '): { alias: string; id: string }[] {',
      '  return marker(a);',
      '}',
      '',
    ].join('\n');
    const body = bodyOf(src, 'shaped');
    expect(body).toContain('marker(a)');
    expect(body.trimEnd().endsWith('}')).toBe(true);
  });
});
