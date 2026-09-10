"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBlocked = handleBlocked;
exports.sweepBlocked = sweepBlocked;
const env_1 = require("./env");
const kommo_1 = require("./kommo");
const supabase_1 = require("./handlers/supabase");
const no_response_1 = require("./no-response");
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
 * `Link sent` tag off.
 *
 * The loss reason is left empty by not sending one. It cannot be sent here even
 * as null: Kommo checks `loss_reason_id` against the stage the lead is in *now*,
 * so anything in that field rejects the whole PATCH with "Loss reason can be
 * specified only for lost lead" and the move never happens.
 */
async function markLeadLost(leadId, contactId) {
    try {
        const lead = await (0, kommo_1.get)(`/leads/${leadId}?with=tags`);
        const tags = lead?._embedded?.tags ?? [];
        const body = { status_id: kommo_1.STAGE.LOST };
        if (!(0, kommo_1.hasTag)(tags, kommo_1.BLOCKED_TAG))
            body.tags_to_add = [{ name: kommo_1.BLOCKED_TAG }];
        const linkSent = tags.filter(t => t.name?.toLowerCase() === LINK_SENT_TAG.toLowerCase());
        if (linkSent.length > 0)
            body.tags_to_delete = linkSent.map(t => t.id);
        await (0, kommo_1.patch)(`/leads/${leadId}`, body);
        console.log('[blocked] lead', leadId, '-> Lost | tagged', kommo_1.BLOCKED_TAG);
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
            if ((0, kommo_1.hasTag)(lead._embedded?.tags, kommo_1.BLOCKED_TAG))
                found.push(lead);
        }
        if (leads.length < SWEEP_PAGE_SIZE)
            break;
    }
    return found;
}
let swept = false;
/** Leads already tagged blocked that never reached Lost — the full treatment. */
async function sweepTaggedBlocked() {
    let closed = 0;
    const leads = await blockedLeadsNotLost();
    console.log('[blocked] sweep | Kommo leads tagged', kommo_1.BLOCKED_TAG, 'and not Lost:', leads.length);
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
    return closed;
}
/**
 * Rows that took every rung of the ladder and still never joined. Exactly what
 * the reminder loop does to them from now on — the same markNoResponse — so a
 * lead caught up on at boot and one written off tomorrow are indistinguishable
 * in Kommo. Nothing here says the bot was blocked, so `Bot blocked` is not
 * involved; anyone who really was blocked went through sweepTaggedBlocked()
 * first and is already in Lost, which markNoResponse passes over.
 */
async function sweepLadderExhausted() {
    let closed = 0;
    const rows = await (0, supabase_1.queryLeads)(`reminder_stage=gte.${supabase_1.MAX_STAGE}&joined_at=is.null&limit=1000`);
    console.log('[blocked] sweep | Supabase rows out of reminders and not joined:', rows.length);
    for (const row of rows) {
        // `lost_at` is not the test: a row can carry it from a run whose Kommo move
        // failed. markNoResponse reads the lead and passes over the ones already in
        // Lost, so a stalled move is picked up on the next deploy.
        if (await (0, no_response_1.markNoResponse)(row, 'out of reminders'))
            closed++;
        await sleep(SWEEP_GAP_MS);
    }
    return closed;
}
/**
 * One-time catch-up at boot, in two passes that must stay apart:
 *
 * 1. leads already tagged `Bot blocked` that never reached Lost — blocked, so
 *    they get the whole handleBlocked treatment;
 * 2. rows that ran the reminder ladder out without joining — `No response`,
 *    the same as the reminder loop gives them. Leads already in Lost are
 *    skipped by reading the lead, not by trusting `lost_at`.
 *
 * Runs once per deploy.
 */
async function sweepBlocked() {
    if (swept) {
        console.log('[blocked] sweep already ran for this deploy - skipping');
        return 0;
    }
    swept = true;
    let blocked = 0;
    let exhausted = 0;
    try {
        blocked = await sweepTaggedBlocked();
    }
    catch (err) {
        console.error('[blocked] sweep (tagged blocked) failed:', (0, env_1.errText)(err));
    }
    try {
        exhausted = await sweepLadderExhausted();
    }
    catch (err) {
        console.error('[blocked] sweep (out of reminders) failed:', (0, env_1.errText)(err));
    }
    console.log('[blocked] sweep finished |', blocked, 'blocked ->', exhausted, 'out of reminders -> Lost');
    return blocked + exhausted;
}
