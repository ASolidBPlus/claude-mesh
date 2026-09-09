import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// THIS REPOSITORY IS PUBLIC, and that is the whole argument for this file.
//
// A secret committed here is world-readable the moment it is pushed, and
// deleting it does not undo that: the object stays reachable to anyone who
// learns its SHA, which a PR comment or a CI log publishes for free. The
// private repo next door had this check queued; the one where a miss cannot be
// undone had none.
//
// TWO HAZARDS, and only the first is what people picture:
//
//   CREDENTIAL CONTENT — a key or token pasted into a file that is otherwise
//   perfectly ordinary. No path pattern catches that.
//
//   AN IGNORED PATH THAT STOPS BEING IGNORED — the dangerous one, because it is
//   silent. `.gitignore` covers the paths the tools use TODAY; a tool writing
//   `.env.local` instead of `.env`, a `git add -f`, or a rename to `PLAN-2.md`
//   walks straight past it. That is exactly how the sibling repo leaked a
//   mnemonic and two tokens: the ignore covered the directory CI happened to
//   set, while the library's own default wrote somewhere else.
//
// THE LISTS BELOW ARE DELIBERATELY INDEPENDENT OF `.gitignore`. Deriving them
// from it would make this check agree with the thing it is checking — a
// `.gitignore` that quietly stops matching would take the test with it, which
// is the failure this file exists to notice.

const REPO = join(import.meta.dir, '../..');

const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO }).split('\n').filter(Boolean);

/** Paths that must never be tracked, whatever `.gitignore` currently says. */
const SECRET_PATHS: RegExp[] = [
  // Any .env variant, not just the bare name the ignore file spells.
  /(^|\/)\.env($|\.)/,
  // Databases: the mesh DB holds token HASHES and the whole agent roster.
  /\.(db|db-wal|db-shm|sqlite|sqlite3)$/,
  /^\.codegraph\//,
  // Key material.
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)id_(rsa|ecdsa|ed25519)(\.pub)?$/,
  // Fleet-internal working documents. Not credentials, but the owner keeps them
  // out of the public repo on purpose, and a rename is all it takes.
  //
  // THE RENAME THE COMMENT WARNED ABOUT WAS THE ONE THAT ESCAPED (seat 2). This
  // was root-anchored with an optional NUMERIC suffix, so it caught `PLAN-2.md`
  // — and `PLAN-notes.md`, `plan.md`, `docs/PLAN.md`, `HANDOFF_old.md` and
  // `PLAN.txt` all walked past. The fixture demonstrated the covered case and
  // was named for a rename, so a reader checked it, saw "rename", and stopped.
  //
  // Now: the STEM at the start of a basename, at ANY depth, with any separator
  // and suffix, case-insensitive, on any text extension. `upgrade-plan.md` is
  // deliberately NOT caught — the stem must start the name — and the fixtures
  // below assert that boundary in both directions.
  /(^|\/)(claude|handoff|orchestrator-defaults|plan|plan_eval|eval)([-_.][A-Za-z0-9]+)*\.(md|markdown|txt)$/i,
  /(^|\/)sprints\//,
];

/**
 * Credential-shaped content, by ISSUER PREFIX rather than by entropy.
 *
 * Entropy would flag things this repository legitimately tracks, and the
 * examples have to be ones a SOURCE scan actually sees (seat 2 caught the first
 * version citing `'a'.repeat(64)`, which is built at runtime and never appears
 * as a 64-character run in any file). Reproducible ones: `gate.sh` carries full
 * 40-hex SHAs as pinned fixtures and 40-character `aaaa…` literals in its
 * selftest, and this suite has `admin-secret-value-do-not-log`.
 *
 * A check that cries wolf on what the repo legitimately tracks earns an
 * exemption list, then a wider one, then it is decoration. A prefix is what a
 * real key looks like and what a fixture never does.
 *
 * The needles are ASSEMBLED rather than written, so this file does not contain
 * the literals it forbids. Every alternative was worse: a self-exemption in the
 * walk below would have to be justified and could hide a real hit in this file,
 * and the third instance of this trap today is enough to make assembly the
 * habit rather than the workaround.
 */
const GH = 'gh' + 'p_';
const GH_PAT = 'github' + '_pat_';
const OAI = 'sk' + '-';
// THIS FLEET'S OWN ISSUER, and its absence was the amendment (seat 2). Every
// agent here is spawned with an ANTHROPIC_API_KEY, and the openai-style pattern
// cannot match one: `sk-ant-api03-…` ends the `[A-Za-z0-9]` class at the hyphen
// three characters in, so the key that would actually leak from THIS repository
// was the one shape not covered. The label was honest and the coverage was not.
const ANT = 'sk' + '-ant-api';
const AWS = 'AK' + 'IA';
const SLACK = 'xox';
const PEM_HEAD = '-----BEGIN ';

export function secretHits(text: string): string[] {
  const patterns: [string, RegExp][] = [
    ['github token', new RegExp(`\\b${GH}[A-Za-z0-9]{20,}`)],
    ['github fine-grained token', new RegExp(`\\b${GH_PAT}[A-Za-z0-9_]{20,}`)],
    ['openai-style key', new RegExp(`\\b${OAI}[A-Za-z0-9]{20,}`)],
    ['anthropic key', new RegExp(`\\b${ANT}\\d+-[A-Za-z0-9_-]{20,}`)],
    ['aws access key id', new RegExp(`\\b${AWS}[0-9A-Z]{16}\\b`)],
    ['slack token', new RegExp(`\\b${SLACK}[baprs]-[A-Za-z0-9-]{10,}`)],
    ['private key block', new RegExp(`${PEM_HEAD}[A-Z ]*PRIVATE KEY-----`)],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe('nothing secret is tracked in a public repository', () => {
  const files = tracked();

  // THE CONTROL EVERY WALK IN THIS SUITE NEEDS. An empty or tiny list makes
  // every assertion below pass having examined nothing.
  it('CONTROL: the walk finds the tracked files', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('server/db.ts');
    expect(files).toContain('.gitignore');
  });

  it('no tracked path is a secret-shaped one', () => {
    const bad = files.filter(f => SECRET_PATHS.some(re => re.test(f)));
    expect(bad).toEqual([]);
  });

  // THE PATH LIST IS CONTROLLED TOO, against strings that are NOT in the repo:
  // a list of regexes that had quietly stopped matching would pass the
  // assertion above for the same reason an empty walk does.
  it('CONTROL: the path patterns match the shapes they are written for', () => {
    const shouldMatch = [
      '.env', '.env.local', 'client/.env.production', 'mesh.db', 'data/mesh.sqlite',
      '.codegraph/codegraph.db', 'keys/server.pem', 'deploy/id_ed25519', 'CLAUDE.md',
      'HANDOFF.md', 'PLAN-2.md', 'sprints/sprint-1.md',
      // The renames that walked past the first version — a suffix is not the
      // only way a file gets renamed, and none of these is exotic.
      'PLAN-notes.md', 'plan.md', 'docs/PLAN.md', 'HANDOFF_old.md', 'PLAN.txt',
      'notes/sprints/sprint-2.md', 'EVAL.markdown',
    ];
    const missed = shouldMatch.filter(p => !SECRET_PATHS.some(re => re.test(p)));
    expect(missed).toEqual([]);

    // ...and it does not match ordinary source, or the assertion above would be
    // failing for everything rather than passing for nothing.
    const shouldNotMatch = [
      'server/db.ts', 'docs/FEDERATION.md', 'README.md', 'package.json',
      // THE BOUNDARY OF THE BROADENING: the stem must START the basename, or
      // an ordinary document with a planning word in its name would be caught
      // and the list would be widened back out by whoever hit it.
      'docs/upgrade-plan.md', 'docs/evaluation.md', 'server/plans.ts',
    ];
    const overreach = shouldNotMatch.filter(p => SECRET_PATHS.some(re => re.test(p)));
    expect(overreach).toEqual([]);
  });

  it('no tracked TEXT file carries credential-shaped content', () => {
    const offenders: string[] = [];
    for (const f of files) {
      // This file holds the needles by construction; it is skipped by NAME, and
      // the predicate itself is controlled by fixtures below rather than by
      // this walk.
      if (f.endsWith('no-committed-secrets.test.ts')) continue;
      const full = join(REPO, f);
      if (!existsSync(full)) continue;              // a deleted-but-staged path
      let text: string;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }   // binary
      const hits = secretHits(text);
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  // THE PREDICATE'S OWN FIXTURES. The walk above can only say "nothing found",
  // which is what a broken predicate also says.
  it('CONTROL: the content patterns fire on synthetic credentials', () => {
    const fake = [
      GH + 'A'.repeat(36),
      GH_PAT + 'B'.repeat(30),
      OAI + 'C'.repeat(32),
      AWS + 'ABCDEFGHIJKLMNOP',
      SLACK + 'b-1234567890-abcdefghij',
      ANT + '03-' + 'D'.repeat(40),
      PEM_HEAD + 'OPENSSH PRIVATE KEY-----',
    ];
    for (const s of fake) expect([s.slice(0, 6), secretHits(s).length]).toEqual([s.slice(0, 6), 1]);
  });

  it('CONTROL: the content patterns do NOT fire on this suite\'s own fixtures', () => {
    // The values that made an entropy check unusable here, asserted as clean so
    // the tightness is a decision rather than an accident.
    const innocent = [
      "token_hash: 'a'.repeat(64)",
      "const ADMIN = 'admin-secret-value-do-not-log';",
      'registerAgent(db, { id: "disk-sender" })',      // contains "sk-"
      'ws://127.0.0.1:7384',
    ];
    for (const s of innocent) expect([s.slice(0, 12), secretHits(s)]).toEqual([s.slice(0, 12), []]);
  });

  // THE IGNORE FILE IS THE PREVENTION AND THIS TEST IS THE NOTICE. They are
  // separate on purpose (see the header), but the ignore must at least cover
  // the shapes tools in this repo actually write, or every run of the suite is
  // one `git add -A` away from doing the work.
  it('.gitignore covers the .env family, not just the bare name', () => {
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    // THE STAR IS THE ASSERTION. `.env` alone matches one file; the tools that
    // write secrets here write `.env.local` and `.env.production`, so a pattern
    // without it passes this line while covering none of them.
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^\*\.db$/m);
    expect(ignore).toMatch(/^\.codegraph\/$/m);
  });
});
