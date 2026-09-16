const GCALENDAR_API = "https://www.googleapis.com/calendar/v3";
const EVENTS_URL = `${GCALENDAR_API}/calendars/primary/events`;

/**
 * Private extended properties carried by every event Rasmalai creates. They are
 * the ONLY thing a sync uses to decide an event is ours.
 *
 * events.list filters on them server-side, so a sync that lists by tag is never
 * handed an event the user made themselves and has no way to change one.
 * Client-chosen event ids would not do the same job: Google does not guarantee
 * an id collision is detected at creation, so an id cannot prevent duplicates.
 */
export const TAG = Object.freeze({ owner: "rasmalai", date: "rasmalaiDate", slot: "rasmalaiSlotId" });

// Off the calendar, but kept in the schedule. Done and InProgress stay on: that
// time was still spent on them.
const OFF_CALENDAR = new Set(["Skipped", "Rescheduled"]);

export function isOurs(event) {
    return event?.extendedProperties?.private?.[TAG.owner] === "1";
}

function nextDay(ymd) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/**
 * The event for one slot. An end at or before the start runs past midnight —
 * "23:00-00:00" is an hour, not a negative range Google would reject.
 */
export function slotEvent(date, slot, timeZone) {
    const endDate = slot.endTime <= slot.startTime ? nextDay(date) : date;
    return {
        summary: slot.title,
        description: slot.notes || "",
        start: { dateTime: `${date}T${slot.startTime}:00`, timeZone },
        end: { dateTime: `${endDate}T${slot.endTime}:00`, timeZone },
        extendedProperties: {
            private: { [TAG.owner]: "1", [TAG.date]: date, [TAG.slot]: slot.slotId },
        },
    };
}

/** Epoch ms for a dateTime, whether Google returned it with an offset or we wrote it naive. */
function instantOf(dateTime, timeZone) {
    if (!dateTime) return NaN;
    if (/(Z|[+-]\d{2}:\d{2})$/.test(dateTime)) return new Date(dateTime).getTime();
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(new Date(`${dateTime}Z`))
        .find(p => p.type === "timeZoneName")?.value ?? "";
    return new Date(`${dateTime}${name.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? "+00:00"}`).getTime();
}

function matches(event, want, timeZone) {
    return event.summary === want.summary
        && (event.description ?? "") === want.description
        && instantOf(event.start?.dateTime, timeZone) === instantOf(want.start.dateTime, timeZone)
        && instantOf(event.end?.dateTime, timeZone) === instantOf(want.end.dateTime, timeZone);
}

/**
 * What to do to one day of the calendar so it matches the schedule. Pure.
 *
 * Keyed on slotId, so an edited slot is patched in place and keeps its event
 * id — anything the user attached to that event survives the change. An event
 * without our tag is skipped even if it is handed in: the list call already
 * excludes those, and this makes that guarantee not depend on it.
 *
 * @returns {{ insert: object[], patch: {id, body}[], remove: string[], unchanged: number }}
 */
export function planDaySync(date, slots, existingEvents, timeZone) {
    const wanted = new Map();
    for (const slot of slots ?? []) {
        if (!OFF_CALENDAR.has(slot.status)) wanted.set(slot.slotId, slotEvent(date, slot, timeZone));
    }

    // Oldest first, so when an interrupted sync left two events for one slot the
    // original is the one that survives.
    const ours = (existingEvents ?? [])
        .filter(isOurs)
        .sort((a, b) => String(a.created ?? "").localeCompare(String(b.created ?? "")));

    const plan = { insert: [], patch: [], remove: [], unchanged: 0 };
    const kept = new Set();

    for (const event of ours) {
        const slotId = event.extendedProperties.private[TAG.slot];
        const want = wanted.get(slotId);
        if (!want || kept.has(slotId)) {
            plan.remove.push(event.id);
            continue;
        }
        kept.add(slotId);
        if (matches(event, want, timeZone)) plan.unchanged++;
        else plan.patch.push({ id: event.id, body: want });
    }

    for (const [slotId, body] of wanted) {
        if (!kept.has(slotId)) plan.insert.push(body);
    }
    return plan;
}

async function call(token, url, { method = "GET", body } = {}) {
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        // A proxy block page or an empty 204 — the status is what matters.
    }
    return { ok: res.ok, status: res.status, data, error: data?.error?.message ?? (res.ok ? null : `HTTP ${res.status}`) };
}

/** Every event Rasmalai put on this day, across pages. Never returns the user's own events. */
export async function listDayEvents(token, date) {
    const events = [];
    let pageToken;
    do {
        const params = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
        // Repeated filters are ANDed by Google.
        params.append("privateExtendedProperty", `${TAG.owner}=1`);
        params.append("privateExtendedProperty", `${TAG.date}=${date}`);
        if (pageToken) params.set("pageToken", pageToken);

        const res = await call(token, `${EVENTS_URL}?${params}`);
        if (!res.ok) throw new Error(`[calendar] listing ${date} failed: ${res.error}`);
        events.push(...(res.data?.items ?? []));
        pageToken = res.data?.nextPageToken;
    } while (pageToken);
    return events;
}

export async function patchEvent(token, id, body) {
    return call(token, `${EVENTS_URL}/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export async function deleteEvent(token, id) {
    const res = await call(token, `${EVENTS_URL}/${encodeURIComponent(id)}`, { method: "DELETE" });
    // Already gone is the outcome we wanted.
    return res.status === 404 || res.status === 410 ? { ...res, ok: true } : res;
}
