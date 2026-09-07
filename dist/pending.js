"use strict";
/**
 * In-memory pending-match table.
 *
 * Kommo's contact chats come back empty on this account, so the Telegram user
 * id cannot be read back from Kommo. Instead every update we forward to Kommo
 * is remembered here for a few minutes, and Kommo's incoming-message webhook
 * matches back onto it by message text + author name.
 *
 * Single process only: a restart loses the table, and the next message from
 * that user rebuilds it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushPending = pushPending;
exports.matchPending = matchPending;
exports.pendingSize = pendingSize;
/** Entries older than this are dropped. */
const TTL_MS = 10 * 60 * 1000;
/** With several equal candidates, the newest only wins if it is this fresh. */
const AMBIGUOUS_WINDOW_MS = 15000;
const entries = [];
function norm(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function prune(now) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (now - entries[i].ts > TTL_MS)
            entries.splice(i, 1);
    }
}
/** Remember an update we just forwarded to Kommo. Prunes stale entries. */
function pushPending(entry) {
    const now = Date.now();
    prune(now);
    entries.push({ ...entry, ts: now });
    console.log('[pending] queued | TG user:', entry.telegram_user_id, '| name:', entry.display_name || '-', '| size:', entries.length);
}
/**
 * Find the entry this Kommo message came from: same text, same author name,
 * within the TTL, newest first. Unambiguous matches always win; when several
 * are equal, only a very recent one is trusted. A taken entry is removed.
 */
function matchPending(text, authorName) {
    const now = Date.now();
    prune(now);
    const wantedText = norm(text);
    const wantedName = norm(authorName);
    if (!wantedText)
        return null;
    const candidates = entries
        .filter(e => norm(e.text_forwarded) === wantedText && norm(e.display_name) === wantedName)
        .sort((a, b) => b.ts - a.ts);
    if (candidates.length === 0)
        return null;
    const newest = candidates[0];
    if (candidates.length > 1 && now - newest.ts > AMBIGUOUS_WINDOW_MS) {
        console.warn('[pending] ambiguous match | candidates:', candidates.length, '| name:', authorName);
        return null;
    }
    const index = entries.indexOf(newest);
    if (index >= 0)
        entries.splice(index, 1);
    return newest;
}
/** Current table size — for logging only. */
function pendingSize() {
    return entries.length;
}
