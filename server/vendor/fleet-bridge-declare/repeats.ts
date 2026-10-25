// Repeat-safe calls: an action that changes something takes an input `id`, and a call repeated
// with the same id gets the first call's answer back instead of running again. That makes every
// retry safe: a caller that timed out sends the same call again, and nothing happens twice.
//   - Scoped per caller and action: one caller's id never answers another's.
//   - The same id with different input is refused (ID_REUSED), never answered with the old result.
//   - Only a run that started is remembered. A refusal before the handler (who, access, input)
//     doesn't spend the id.
//   - A repeat that arrives while the first is still running waits for the first's answer.
// The memory is a RepeatStore: memoryRepeats() by default, bounded by count and age; an app that
// must remember across restarts plugs in its own.
import { createHash } from 'node:crypto';

export const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A call's answer as it was sent: the status and the JSON body. */
export interface Answer {
  status: number;
  body: unknown;
}

export interface Remembered {
  inputSha256: string;
  answer: Answer;
}

export interface RepeatStore {
  get(key: string): Remembered | undefined | Promise<Remembered | undefined>;
  set(key: string, value: Remembered): void | Promise<void>;
}

/** The default store: the last `max` answers, each kept for `ttlMs`. */
export function memoryRepeats(opts: { max?: number | undefined; ttlMs?: number | undefined; now?: (() => number) | undefined } = {}): RepeatStore {
  const max = opts.max ?? 10_000;
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60_000;
  const now = opts.now ?? Date.now;
  const kept = new Map<string, { at: number; value: Remembered }>();
  return {
    get(key) {
      const e = kept.get(key);
      if (e === undefined) return undefined;
      if (now() - e.at > ttlMs) {
        kept.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value) {
      kept.delete(key);
      while (kept.size >= max) kept.delete(kept.keys().next().value!);
      kept.set(key, { at: now(), value });
    },
  };
}

/** JSON with object keys sorted, so the same input always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const inputSha256 = (input: unknown) => createHash('sha256').update(stable(input)).digest('hex');

export type RepeatOutcome = { kind: 'run'; finish: (a: Answer) => Promise<void> } | { kind: 'repeat'; answer: Answer } | { kind: 'reused' };

/**
 * The gate in front of a changing action's handler. claim() says whether to run it, answer with
 * the first call's answer, or refuse the id as reused; a run must finish() with its answer.
 */
export class RepeatGate {
  private readonly running = new Map<string, { inputSha256: string; done: Promise<Answer> }>();
  constructor(private readonly store: RepeatStore) {}

  async claim(caller: string, action: string, id: string, input: unknown): Promise<RepeatOutcome> {
    const key = `${caller}\n${action}\n${id}`;
    const hash = inputSha256(input);
    const inFlight = this.running.get(key);
    if (inFlight !== undefined) return inFlight.inputSha256 === hash ? { kind: 'repeat', answer: await inFlight.done } : { kind: 'reused' };
    const seen = await this.store.get(key);
    if (seen !== undefined) return seen.inputSha256 === hash ? { kind: 'repeat', answer: seen.answer } : { kind: 'reused' };
    // a second call may have claimed it while the store was read
    const raced = this.running.get(key);
    if (raced !== undefined) return raced.inputSha256 === hash ? { kind: 'repeat', answer: await raced.done } : { kind: 'reused' };
    let resolve!: (a: Answer) => void;
    const done = new Promise<Answer>((r) => (resolve = r));
    this.running.set(key, { inputSha256: hash, done });
    return {
      kind: 'run',
      finish: async (answer) => {
        try {
          await this.store.set(key, { inputSha256: hash, answer });
        } finally {
          this.running.delete(key);
          resolve(answer);
        }
      },
    };
  }
}
