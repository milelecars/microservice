"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLOCKED_TAG = void 0;
exports.handleBlocked = handleBlocked;
exports.sweepBlocked = sweepBlocked;
const env_1 = require("./env");
const kommo_1 = require("./kommo");
const supabase_1 = require("./handlers/supabase");
/** Marks a lead the bot can no longer reach. Also what the dashboard reads. */
exports.BLOCKED_TAG = 'Bot blocked';
/** Dropped when the lead goes to Lost — the link is moot once we are blocked. */
const LINK_SENT_TAG = 'Link sent';
/** Leads per page when sweeping the pipeline, and how many pages at most. */
const SWEEP_PAGE_SIZE = 250;
const SWEEP_MAX_PAGES = 40;
/** Breathing room between writes during the sweep, so Kommo does not throttle us. */
const SWEEP_GAP_MS = 250;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Move a Kommo lead to Lost: the stage, the tag that says why, and the
 * `Link sent` tag off. `loss_reason_id: null` leaves the reason empty — being
 * blocked is not one of the pipeline's reasons.
 */
async function markLeadLost(leadId, contactId) {
    try {
        const lead = await (0, kommo_1.get)(`/leads/${leadId}?with=tags`);
        const tags = lead?._embedded?.tags ?? [];
        const body = { status_id: kommo_1.STAGE.LOST, loss_reason_id: null };
        if (!(0, kommo_1.hasTag)(tags, exports.BLOCKED_TAG))
            body.tags_to_add = [{ name: exports.BLOCKED_TAG }];
        const linkSent = tags.filter(t => t.name?.toLowerCase() === LINK_SENT_TAG.toLowerCase());
        if (linkSent.length > 0)
            body.tags_to_delete = linkSent.map(t => t.id);
        await (0, kommo_1.patch)(`/leads/${leadId}`, body);
        console.log('[blocked] lead', leadId, '-> Lost | tagged', exports.BLOCKED_TAG);
    }
    catch (err) {
        console.error('[blocked] lead', leadId, 'could not be moved to Lost:', (0, env_1.errText)(err));
    }
    if (contactId)
        await (0, kommo_1.setContactStatus)(contactId, 'blocked');
}
/**
 * Telegram answered 403: this person has blocked the bot, or the chat is gone.
 * Either way nothing more will ever reach them, so the row and the Kommo lead
 * are closed off here — one place, called from every send path.
 *
 * Idempotent: a row that already carries `lost_at` is left alone.
 * Returns true when this call was the one that closed them off.
 */
async function handleBlocked(telegramUserId, opts = {}) {
    const row = await (0, supabase_1.getLead)(telegramUserId);
    if (row?.lost_at && !opts.force) {
        console.log('[blocked] TG', telegramUserId, 'already marked lost - skipping');
        return false;
    }
    if (row) {
        const changes = { in_channel: false, reminder_stage: supabase_1.MAX_STAGE };
        if (!row.lost_at)
            changes.lost_at = (0, supabase_1.nowIso)();
        await (0, supabase_1.updateLead)(telegramUserId, changes);
    }
    else {
        console.warn('[blocked] no Supabase row for TG', telegramUserId, '- Kommo side only');
    }
    if (row?.kommo_lead_id)
        await markLeadLost(row.kommo_lead_id, row.kommo_contact_id);
    else if (row?.kommo_contact_id)
        await (0, kommo_1.setContactStatus)(row.kommo_contact_id, 'blocked');
    if (row?.kommo_talk_id)
        await (0, kommo_1.closeTalk)(row.kommo_talk_id, telegramUserId);
    console.log('[blocked] TG', telegramUserId, '-> Lost');
    return true;
}
// ── Startup sweep ─────────────────────────────────────────────────────────────
/**
 * Leads in the Founder Circle pipeline that carry the blocked tag but were
 * never moved to Lost — the backlog from before this ran on every 403.
 */
async function blockedLeadsNotLost() {
    const found = [];
    for (let page = 1; page <= SWEEP_MAX_PAGES; page++) {
        const data = await (0, kommo_1.get)(`/leads?filter[pipeline_id]=${kommo_1.PIPELINE_ID}&with=contacts,tags` +
            `&limit=${SWEEP_PAGE_SIZE}&page=${page}`);
        const leads = data?._embedded?.leads ?? [];
        for (const lead of leads) {
            if (lead.status_id === kommo_1.STAGE.LOST)
                continue;
            if ((0, kommo_1.hasTag)(lead._embedded?.tags, exports.BLOCKED_TAG))
                found.push(lead);
        }
        if (leads.length < SWEEP_PAGE_SIZE)
            break;
    }
    return found;
}
let swept = false;
/**
 * One-time catch-up at boot, for everyone the bot gave up on before this
 * existed: rows that ran the reminder ladder out without joining, and leads
 * already tagged blocked that never reached Lost. Runs once per deploy.
 */
async function sweepBlocked() {
    if (swept) {
        console.log('[blocked] sweep already ran for this deploy - skipping');
        return 0;
    }
    swept = true;
    let closed = 0;
    try {
        const rows = await (0, supabase_1.queryLeads)(`reminder_stage=gte.${supabase_1.MAX_STAGE}&joined_at=is.null&lost_at=is.null&limit=1000`);
        console.log('[blocked] sweep | Supabase rows out of reminders and not joined:', rows.length);
        for (const row of rows) {
            if (!row.telegram_user_id)
                continue;
            if (await handleBlocked(row.telegram_user_id))
                closed++;
            await sleep(SWEEP_GAP_MS);
        }
    }
    catch (err) {
        console.error('[blocked] sweep (Supabase side) failed:', (0, env_1.errText)(err));
    }
    try {
        const leads = await blockedLeadsNotLost();
        console.log('[blocked] sweep | Kommo leads tagged', exports.BLOCKED_TAG, 'and not Lost:', leads.length);
        for (const lead of leads) {
            const row = await (0, supabase_1.getLeadByKommoLeadId)(lead.id);
            if (row?.telegram_user_id) {
                if (await handleBlocked(row.telegram_user_id, { force: true }))
                    closed++;
            }
            else {
                const contacts = lead._embedded?.contacts ?? [];
                const mainContact = contacts.find(c => c.is_main) ?? contacts[0];
                await markLeadLost(lead.id, mainContact?.id);
                closed++;
            }
            await sleep(SWEEP_GAP_MS);
        }
    }
    catch (err) {
        console.error('[blocked] sweep (Kommo side) failed:', (0, env_1.errText)(err));
    }
    console.log('[blocked] sweep finished |', closed, 'leads moved to Lost');
    return closed;
}
