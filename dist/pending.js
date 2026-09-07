"use strict";
/**
 * In-memory pending-match table.
 *
 * Kommo's contact chats come back empty on this account, so the Telegram user
 * id cannot be read back from Kommo. Instead every update we forward to Kommo
 * is remembered here for a few minutes, and Kommo's incoming-message webhook
 * matches back onto it by the message text.
 *
 * The author name is NOT part of the match: Telegram gives us
 * first_name + last_name ("Helia") while Kommo names the contact from what the
 * person typed ("Helia H"), so requiring equality never matched. It is only
 * used to break a tie between several entries carrying the same text.
 *
 * Single process only: a restart loses the table, and the next message from
 * that user rebuilds it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FALLBACK_WINDOW_MS = exports.MATCH_WINDOW_MS = void 0;
exports.pushPending = pushPending;
exports.matchPendingByText = matchPendingByText;
exports.recentPending = recentPending;
exports.takePending = takePending;
exports.listPending = listPending;
exports.pendingSize = pendingSize;
exports.clearPending = clearPending;
/** Entries older than this are dropped. */
const TTL_MS = 10 * 60 * 1000;
/** How far back a text match may reach. */
exports.MATCH_WINDOW_MS = 60000;
/** How far back the "first message of a new lead" fallback may reach. */
exports.FALLBACK_WINDOW_MS = 60000;
const entries = [];
let counter = 0;
/** Both sides of every comparison go through this. */
function norm(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function prune(now) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (now - entries[i].ts > TTL_MS)
            entries.splice(i, 1);
    }
}
function view(entry, now) {
    return {
        tg: entry.telegram_user_id,
        text: entry.text_forwarded,
        name: entry.display_name,
        ageSeconds: Math.round((now - entry.ts) / 1000),
    };
}
/** Remember an update we just forwarded to Kommo. Prunes stale entries. */
function pushPending(entry) {
    const now = Date.now();
    prune(now);
    entries.push({ ...entry, ts: now, seq: ++counter });
    console.log('[pending] queued | TG user:', entry.telegram_user_id, '| text:', entry.text_forwarded, '| name:', entry.display_name || '-', '| size:', entries.length);
}
/**
 * The entry this Kommo message came from, matched on text alone: newest first,
 * within MATCH_WINDOW_MS. When several entries carry the same text, the author
 * name breaks the tie (prefix match either way, since Telegram and Kommo spell
 * the person's name differently). Does not remove — call takePending() once the
 * link actually succeeded.
 */
function matchPendingByText(text, authorName) {
    const now = Date.now();
    prune(now);
    const wantedText = norm(text);
    if (!wantedText)
        return null;
    const candidates = entries
        .filter(e => now - e.ts <= exports.MATCH_WINDOW_MS && norm(e.text_forwarded) === wantedText)
        .sort((a, b) => b.seq - a.seq);
    if (candidates.length === 0)
        return null;
    if (candidates.length === 1)
        return candidates[0];
    const wantedName = norm(authorName);
    if (wantedName) {
        const byName = candidates.filter(e => {
            const name = norm(e.display_name);
            return name.length > 0 && (name.startsWith(wantedName) || wantedName.startsWith(name));
        });
        if (byName.length > 0)
            return byName[0];
    }
    return candidates[0];
}
/** Entries from the last `withinMs`, newest first. */
function recentPending(withinMs = exports.FALLBACK_WINDOW_MS) {
    const now = Date.now();
    prune(now);
    return entries.filter(e => now - e.ts <= withinMs).sort((a, b) => b.seq - a.seq);
}
/** Drop an entry once it has been linked. Returns whether it was still there. */
function takePending(entry) {
    const index = entries.indexOf(entry);
    if (index < 0)
        return false;
    entries.splice(index, 1);
    return true;
}
/** The whole table, newest first — for logs and /debug/pending. */
function listPending() {
    const now = Date.now();
    prune(now);
    return entries.slice().sort((a, b) => b.seq - a.seq).map(e => view(e, now));
}
/** Current table size — for logging only. */
function pendingSize() {
    return entries.length;
}
/** Test seam: empty the table. */
function clearPending() {
    entries.length = 0;
    counter = 0;
}
