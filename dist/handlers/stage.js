"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleStageChange = handleStageChange;
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const identity_1 = require("./identity");
const supabase_1 = require("./supabase");
// This route is called by Kommo on lead status change
async function handleStageChange(req, res) {
    res.status(200).json({ ok: true });
    const body = req.body;
    setImmediate(async () => {
        try {
            const lead = body?.leads?.status?.[0] ?? body?.leads?.add?.[0] ?? body?.leads?.update?.[0];
            if (!lead?.id) {
                console.warn('[stage] no lead in payload - skipping');
                return;
            }
            const leadId = String(lead.id);
            const statusId = Number(lead.status_id);
            const stages = await (0, kommo_1.getStageMap)();
            const stageName = stages[statusId];
            console.log('[stage] lead:', leadId, '-> status:', statusId, '|', stageName ?? 'unknown stage');
            // Look up TG user ID from Kommo lead to update Supabase by telegram_user_id
            const fullLead = await (0, kommo_1.get)(`/leads/${leadId}?with=contacts`);
            const contacts = fullLead?._embedded?.contacts ?? [];
            const mainContact = contacts.find(c => c.is_main) ?? contacts[0];
            const { telegramUserId, row } = await (0, identity_1.resolveTelegramId)('[stage]', fullLead, leadId, mainContact?.id);
            if (!telegramUserId) {
                console.warn('[stage] could not resolve TG user ID for lead:', leadId, '- skipping Supabase update');
                return;
            }
            const changes = { kommo_lead_id: leadId };
            if (stageName)
                changes.kommo_stage = stageName;
            // Stage-driven milestones, matched on status id (names change in Kommo)
            if (statusId === kommo_1.STAGE.JOINED_CHANNEL) {
                changes.in_channel = true;
                const existing = row ?? (await (0, supabase_1.getLead)(telegramUserId));
                if (!existing?.joined_at)
                    changes.joined_at = (0, supabase_1.nowIso)();
            }
            else if (statusId === kommo_1.STAGE.LOST) {
                changes.lost_at = (0, supabase_1.nowIso)();
            }
            await (0, supabase_1.updateLead)(telegramUserId, changes);
        }
        catch (err) {
            console.error('[stage] error:', (0, env_1.errText)(err));
        }
    });
}
