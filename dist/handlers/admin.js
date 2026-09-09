"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resendJoin = resendJoin;
const env_1 = require("../env");
const telegram_api_1 = require("../telegram-api");
const supabase_1 = require("./supabase");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Everyone who was sent the link but is not in the channel. */
const OUTSTANDING_QUERY = 'link_sent_at=not.is.null&joined_at=is.null&in_channel=is.false&limit=1000';
function authorised(req) {
    const configured = process.env.ADMIN_KEY;
    if (!configured)
        return false;
    return req.header('X-Admin-Key') === configured;
}
async function resendTo(rows) {
    for (const row of rows) {
        if (!row.telegram_user_id)
            continue;
        await (0, telegram_api_1.sendJoinMessage)(row.telegram_user_id);
        console.log('[admin] join message resent to TG', row.telegram_user_id);
        await sleep(1000);
    }
    console.log('[admin] resend-join finished |', rows.length, 'rows');
}
// POST /admin/resend-join — one-time catch-up for people stuck without the card
async function resendJoin(req, res) {
    if (!process.env.ADMIN_KEY) {
        console.warn('[admin] resend-join called but ADMIN_KEY is not set');
        res.status(503).json({ ok: false, error: 'ADMIN_KEY not configured' });
        return;
    }
    if (!authorised(req)) {
        console.warn('[admin] resend-join rejected: bad or missing X-Admin-Key');
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
    }
    try {
        const requested = (req.body ?? {});
        if (requested.telegram_user_id) {
            const row = await (0, supabase_1.getLead)(requested.telegram_user_id);
            if (!row) {
                res.status(404).json({ ok: false, error: 'No row for that telegram_user_id' });
                return;
            }
            const sent = await (0, telegram_api_1.sendJoinMessage)(requested.telegram_user_id);
            console.log('[admin] join message resent to TG', requested.telegram_user_id, '| sent:', sent);
            res.status(200).json({ ok: true, count: sent ? 1 : 0, sent });
            return;
        }
        const rows = (await (0, supabase_1.queryLeads)(OUTSTANDING_QUERY)).filter(r => !!r.telegram_user_id);
        console.log('[admin] resend-join queued |', rows.length, 'rows');
        // Answer with the count now; the sends pace themselves afterwards
        res.status(200).json({ ok: true, count: rows.length, queued: true });
        setImmediate(() => {
            resendTo(rows).catch(err => console.error('[admin] resend-join failed:', (0, env_1.errText)(err)));
        });
    }
    catch (err) {
        console.error('[admin] resend-join error:', (0, env_1.errText)(err));
        if (!res.headersSent)
            res.status(500).json({ ok: false, error: 'Internal Server Error' });
    }
}
