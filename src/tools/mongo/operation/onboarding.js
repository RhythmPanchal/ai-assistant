import { getDB } from "../mongoClient.js";
import { USERS } from "../schema/usersSchema.js";

/**
 * The two writes onboarding makes that the model never makes itself: the
 * one-time welcome, and marking someone onboarded. Both are atomic claims on
 * the users document, so a second /start, or two messages racing, can never
 * send two welcomes or finish onboarding twice.
 */

function assertUserId(fn, userId) {
    if (!Number.isInteger(userId)) throw new Error(`[${fn}] userId must be an integer, got ${userId}`);
}

/**
 * Claim the one welcome message a user ever gets. True for exactly one caller.
 *
 * Separate from onboardedAt on purpose: someone who abandons onboarding and
 * sends /start a day later is still not onboarded, but has been welcomed, and a
 * second "Welcome to Rasmalai" would read like the bot forgot them.
 */
export async function claimWelcome(userId, now = new Date()) {
    assertUserId("claimWelcome", userId);
    const db = await getDB();
    const claimed = await db.collection(USERS).findOneAndUpdate(
        // `: null` matches a missing field as well as a null one.
        { userId, welcomedAt: null },
        { $set: { welcomedAt: now, updatedAt: now } },
        { projection: { _id: 1 } }
    );
    return Boolean(claimed);
}

/**
 * Finish onboarding: stamp onboardedAt and switch routines on — unless they
 * already chose, one way or the other.
 *
 * Only the FIRST completion does anything. A review finishing for someone
 * onboarded long ago moves neither onboardedAt nor their routines, so a user who
 * turned routines off in March does not get them back by reviewing their notes
 * in May.
 *
 * @returns {{ firstCompletion: boolean, onboardedAt: Date|null, preferences: object }}
 */
export async function markOnboarded(userId, now = new Date()) {
    assertUserId("markOnboarded", userId);
    const users = (await getDB()).collection(USERS);

    const claimed = await users.findOneAndUpdate(
        { userId, onboardedAt: null },
        { $set: { onboardedAt: now, updatedAt: now } },
        { returnDocument: "after", projection: { onboardedAt: 1, preferences: 1 } }
    );

    if (!claimed) {
        const user = await users.findOne({ userId }, { projection: { onboardedAt: 1, preferences: 1 } });
        if (!user) throw new Error(`[markOnboarded] no user with userId ${userId}`);
        return { firstCompletion: false, onboardedAt: user.onboardedAt ?? null, preferences: user.preferences ?? {} };
    }

    const preferences = claimed.preferences ?? {};
    // An explicit choice — "no daily messages" during onboarding, or any on/off
    // before it — is theirs to keep. Only the untouched default is switched on.
    if (preferences.routinesChosenAt) {
        return { firstCompletion: true, onboardedAt: claimed.onboardedAt, preferences };
    }

    await users.updateOne(
        { userId },
        // A null preferences object cannot take a dotted $set.
        claimed.preferences
            ? { $set: { "preferences.triggersOptIn": true } }
            : { $set: { preferences: { triggersOptIn: true } } }
    );
    return { firstCompletion: true, onboardedAt: claimed.onboardedAt, preferences: { ...preferences, triggersOptIn: true } };
}
