"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviveLead = reviveLead;
const env_1 = require("./env");
const kommo_1 = require("./kommo");
const supabase_1 = require("./handlers/supabase");
/**
 * Someone written off as Lost has come back: a message, a `/start`, a tap, or
 * the channel join itself. Undo the writing-off, in both places.
 *
 * `lost_at` is cleared, the `No response` tag comes off the lead, and the lead
 * goes back to In Conversation - or straight to Joined Channel when the thing
 * that brought them back was the join. Nothing happens for a row that was not
 * lost, so every caller can hand it whatever row it already has.
 *
 * The lead's current stage is read first, so a lead already sitting where it
 * belongs is not patched again; welcomeUser has usually just moved it.
 */
async function reviveLead(telegramUserId, row, opts = {}) {
    if (!row?.lost_at)
        return;
    const target = opts.joined ? kommo_1.STAGE.JOINED_CHANNEL : kommo_1.STAGE.IN_CONVERSATION;
    await (0, supabase_1.updateLead)(telegramUserId, { lost_at: null });
    if (row.kommo_lead_id) {
        try {
            const lead = await (0, kommo_1.get)(`/leads/${row.kommo_lead_id}?with=tags`);
            const noResponse = (lead?._embedded?.tags ?? []).filter(t => t.name?.toLowerCase() === kommo_1.NO_RESPONSE_TAG.toLowerCase());
            const body = {};
            if (lead?.status_id !== target)
                body.status_id = target;
            if (noResponse.length > 0)
                body.tags_to_delete = noResponse.map(t => t.id);
            if (Object.keys(body).length > 0)
                await (0, kommo_1.patch)(`/leads/${row.kommo_lead_id}`, body);
        }
        catch (err) {
            console.error('[revive] lead', row.kommo_lead_id, 'could not be brought back:', (0, env_1.errText)(err));
        }
    }
    console.log('[revive] TG', telegramUserId, '-> back from Lost |', opts.joined ? 'Joined Channel' : 'In Conversation');
}
