import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who the current unit of work is being done FOR.
 *
 * Until now the answer travelled as a userId parameter that the LLM filled in,
 * having read it out of its own system prompt. That makes the model a confused
 * deputy: the authority arrives through a channel the user's own text can
 * influence, so "actually my userId is 2" is an escalation attempt with a real
 * chance of working. Worse, the tools where userId is buried inside a
 * model-built structure — fetchRecord's filters, updateRecords' _id — had no
 * scoping at all.
 *
 * So identity stops being an argument. It is bound once, at the entry point
 * that actually authenticated it, and read from here by everything downstream.
 *
 * AsyncLocalStorage is what makes that safe under concurrency. It is NOT a
 * module-level variable: Node records which async context created every promise,
 * timer and callback, so a store bound by run() is inherited by that chain and
 * only that chain. Two users' turns interleave at every await on the same
 * thread, and each still reads its own store. A plain variable would be
 * clobbered by whichever request wrote last — which is precisely the leak this
 * exists to prevent.
 */

const storage = new AsyncLocalStorage();

/**
 * Reserved id for work the system does on its own behalf rather than a user's —
 * migrations, seeds, maintenance. Negative so it can never collide with the
 * counter, which allocates from 1 upward.
 */
export const SYSTEM_USER_ID = -1;

export class UserContext {
    /**
     * @param {object} fields
     * @param {number} fields.userId        internal users.userId, or SYSTEM_USER_ID
     * @param {string} fields.channel       where the request entered: telegram, scheduler, system
     * @param {string} [fields.address]     channel address to reply on, e.g. a Telegram chat id
     * @param {Date}   [fields.executionTime] when this unit of work began
     * @param {string} [fields.reason]      why, for system contexts — shows up in logs
     */
    constructor({ userId, channel, address = null, executionTime = new Date(), reason = null }) {
        if (!Number.isInteger(userId)) {
            throw new Error(`[UserContext] userId must be an integer, got ${userId}`);
        }
        if (!channel) {
            throw new Error("[UserContext] channel is required — it records where identity was established");
        }

        this.userId = userId;
        this.channel = channel;
        this.address = address === null || address === undefined ? null : String(address);
        this.executionTime = executionTime;
        this.reason = reason;

        // Frozen because a context is a claim about who authenticated, made once.
        // Anything able to edit it mid-turn would reintroduce exactly the problem
        // this class removes.
        Object.freeze(this);
    }

    /**
     * System work is exempt from per-user scoping — it legitimately reads and
     * writes across users. Callers in the data layer check this INSTEAD of
     * filtering by userId; filtering to -1 would match nothing rather than
     * everything, which is the opposite of what a migration needs.
     */
    get isSystem() {
        return this.userId === SYSTEM_USER_ID;
    }

    toString() {
        return this.isSystem
            ? `system(${this.reason ?? "unspecified"})`
            : `user ${this.userId} via ${this.channel}`;
    }
}

/**
 * Bind a context for the duration of `fn`, including everything it awaits.
 *
 * Call this at an entry point — the place that established identity — and
 * nowhere else. There are only four: the Telegram message handler, the callback
 * handler, the routine jobs, and the trigger executor.
 */
export function runWithUserContext(userContext, fn) {
    const context = userContext instanceof UserContext ? userContext : new UserContext(userContext);
    return storage.run(context, fn);
}

/**
 * Run `fn` as the system, exempt from per-user scoping.
 *
 * Deliberately a plain function and not a tool: the model has no way to reach
 * it, so it cannot ask to be exempted. Anything invoked from here is trusted
 * server-side code — migrations, boot seeds, maintenance scripts.
 */
export function runAsSystem(reason, fn) {
    return runWithUserContext(
        new UserContext({ userId: SYSTEM_USER_ID, channel: "system", reason }),
        fn
    );
}

/**
 * The bound context. THROWS when there is none.
 *
 * Failing loudly is the entire safety property. Returning undefined would let a
 * caller fall through to an unscoped query — one missing binding and a single
 * fetch reads every user's rows, silently and with a plausible-looking result.
 */
export function getUserContext() {
    const context = storage.getStore();
    if (!context) {
        throw new Error(
            "[userContext] no user context bound. Every entry point must wrap its work in " +
            "runWithUserContext(), or runAsSystem() for work not done on a user's behalf."
        );
    }
    return context;
}

/** The bound context, or null. For logging and diagnostics only — never for scoping a query. */
export function peekUserContext() {
    return storage.getStore() ?? null;
}

export function currentUserId() {
    return getUserContext().userId;
}

/** True when the current work is exempt from per-user scoping. */
export function isSystemContext() {
    return getUserContext().isSystem;
}
