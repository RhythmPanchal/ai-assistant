/**
 * An in-memory Google Calendar behind a fetch stub — just the four calls the
 * sync makes, with the two behaviours it depends on:
 *
 *  - events.list honours repeated privateExtendedProperty filters, ANDed.
 *  - an event whose end is not after its start is refused with 400, as Google
 *    does. Without that, a "23:00-00:00" slot would pass here and fail for real.
 *
 * Telegram is always blocked. Anything else throws unless `passthrough` is set,
 * which the live agent test needs for the LLM calls.
 */
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const clone = (o) => JSON.parse(JSON.stringify(o));

function withOffset(point) {
    if (!point?.dateTime || /(Z|[+-]\d{2}:\d{2})$/.test(point.dateTime)) return point;
    const offset = point.timeZone === "Asia/Kolkata" ? "+05:30" : "Z";
    return { ...point, dateTime: `${point.dateTime}${offset}` };
}

const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function installFakeGoogleCalendar({ passthrough = false } = {}) {
    const realFetch = globalThis.fetch;
    const events = new Map();
    const writes = [];
    let seq = 0;

    const store = (id, body) => {
        const event = { ...body, id, start: withOffset(body.start), end: withOffset(body.end) };
        if (!(new Date(event.end.dateTime) > new Date(event.start.dateTime))) {
            return json(400, { error: { code: 400, message: "The specified time range is empty." } });
        }
        events.set(id, event);
        return json(200, clone(event));
    };

    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const method = (init.method || "GET").toUpperCase();

        if (url.hostname === "api.telegram.org") throw new Error("fake calendar: Telegram is blocked in tests");
        if (!url.href.startsWith(EVENTS)) {
            if (passthrough) return realFetch(input, init);
            throw new Error(`fake calendar: unexpected request ${method} ${url.href}`);
        }

        const id = decodeURIComponent(url.pathname.slice(new URL(EVENTS).pathname.length).replace(/^\//, ""));

        if (method === "GET" && !id) {
            const filters = url.searchParams.getAll("privateExtendedProperty").map(f => {
                const at = f.indexOf("=");
                return [f.slice(0, at), f.slice(at + 1)];
            });
            const items = [...events.values()].filter(e =>
                filters.every(([k, v]) => e.extendedProperties?.private?.[k] === v));
            return json(200, { items: items.map(clone) });
        }
        if (method === "POST" && !id) {
            const newId = `evt${++seq}`;
            const res = store(newId, { ...JSON.parse(init.body), created: new Date(1_700_000_000_000 + seq).toISOString() });
            if (res.ok) writes.push({ method, id: newId });
            return res;
        }
        if (method === "PATCH") {
            if (!events.has(id)) return json(404, { error: { code: 404, message: "Not Found" } });
            const res = store(id, { ...events.get(id), ...JSON.parse(init.body) });
            if (res.ok) writes.push({ method, id });
            return res;
        }
        if (method === "DELETE") {
            if (!events.has(id)) return json(410, { error: { code: 410, message: "Resource has been deleted" } });
            events.delete(id);
            writes.push({ method, id });
            return new Response(null, { status: 204 });
        }
        return json(400, { error: { message: `fake calendar: unsupported ${method}` } });
    };

    return {
        events,
        writes,
        /** An event the USER created — no Rasmalai tag. */
        addUserEvent(body) {
            const id = `mine${++seq}`;
            events.set(id, { ...clone(body), id, created: new Date(1_600_000_000_000 + seq).toISOString() });
            return id;
        },
        /** Insert straight into the calendar, bypassing the sync — to simulate leftovers. */
        inject(event) {
            const id = `inj${++seq}`;
            events.set(id, { ...clone(event), id, created: new Date(1_800_000_000_000 + seq).toISOString() });
            return id;
        },
        tagged(date) {
            return [...events.values()].filter(e =>
                e.extendedProperties?.private?.rasmalai === "1" && e.extendedProperties.private.rasmalaiDate === date);
        },
        reset() {
            events.clear();
            writes.length = 0;
        },
        restore() {
            globalThis.fetch = realFetch;
        },
    };
}
