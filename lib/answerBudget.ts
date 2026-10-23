/**
 * One deadline for a whole answer (#21 §7, #37 review B1).
 *
 * A budget expressed as a duration bounds only whatever it is handed to. An answer is a
 * chain — scope resolution, context, model hops, GitHub reads, ledger writes, the Telegram
 * send — and a duration per link lets the chain outlast the function: the review's worst
 * case reached roughly 130 seconds plus untimed GitHub reads against a 140-second limit,
 * with the status message as the last thing the user would ever see.
 *
 * So the route fixes one absolute instant at the start of the request, and everything
 * downstream measures itself against that instant rather than against its own clock.
 *
 * The arithmetic, which the numbers below have to keep true:
 *
 *   0s ──────────────── tool hops and GitHub reads ──────────────── 100s   ANSWER_DEADLINE_MS
 *                                                  final answer-only call  +20s  FINALISE_RESERVE_MS
 *                                         ledger writes and the send       +20s  (margin)
 *                                                                        = 140s  maxDuration
 *
 * The margin is not slack to be spent: the ledger writes and the Telegram send happen
 * after the last model call, and they are what turns work into something the user can
 * see. scripts/test-answer-budget.ts asserts the route's own literal still matches.
 */

/** The route segment config value this file is sized for. Kept in step by a test. */
export const ANSWER_MAX_DURATION_SECONDS = 140;

/** By when the tool hops and every GitHub read must be done. */
export const ANSWER_DEADLINE_MS = 100_000;

/**
 * Reserved for the final answer-only call. The loop stops making hops once less than this
 * remains, so there is always room for a reply built from what it already has.
 */
export const FINALISE_RESERVE_MS = 20_000;

/** One GitHub request. Clamped to the deadline, so it can only ever be shorter. */
export const GITHUB_CALL_TIMEOUT_MS = 10_000;

/**
 * One Telegram request. Deliberately *not* clamped to the deadline: the final send happens
 * after the deadline by design, and that send is the answer.
 */
export const TELEGRAM_CALL_TIMEOUT_MS = 10_000;

export interface Deadline {
  /** The instant itself, as epoch milliseconds. */
  readonly at: number;
  remainingMs(): number;
  expired(): boolean;
  /**
   * A signal for one request: whichever comes first, `maxMs` from now or the deadline.
   * Never zero — a signal that has already fired would abort the request before it is
   * sent, turning "we are out of time" into "the call failed".
   */
  signal(maxMs: number): AbortSignal;
}

/** A deadline `ANSWER_DEADLINE_MS` from now. The route calls this once, at the top. */
export function startAnswerDeadline(now: () => number = Date.now): Deadline {
  return deadlineAt(now() + ANSWER_DEADLINE_MS, now);
}

/** A deadline at a given instant. Separate from the above so tests can fix the clock. */
export function deadlineAt(at: number, now: () => number = Date.now): Deadline {
  return {
    at,
    remainingMs: () => at - now(),
    expired: () => now() >= at,
    signal: (maxMs: number) => AbortSignal.timeout(Math.max(1, Math.min(maxMs, at - now()))),
  };
}
