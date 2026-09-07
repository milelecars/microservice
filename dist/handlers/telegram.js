"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTelegramWebhook = handleTelegramWebhook;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const supabase_1 = require("./supabase");
const SOURCE_MAP = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    direct: 'Direct',
};
const IN_CHANNEL_STATUSES = ['member', 'administrator', 'creator'];
const OUT_OF_CHANNEL_STATUSES = ['left', 'kicked'];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ── Lead lookup ───────────────────────────────────────────────────────────────
/** Preferred path: the lead already carries the Telegram User ID custom field. */
async function findLeadByCustomField(telegramUserId) {
    try {
        const data = await (0, kommo_1.get)(`/leads?filter[custom_fields][${kommo_1.LEAD_FIELD.TG_USER_ID}]=${encodeURIComponent(String(telegramUserId))}&with=contacts,tags`);
        const leads = data?._embedded?.leads ?? [];
        return leads.find(l => l.pipeline_id === kommo_1.PIPELINE_ID) ?? leads[0] ?? null;
    }
    catch (err) {
        console.error('[telegram] lead filter lookup failed:', (0, env_1.errText)(err));
        return null;
    }
}
/**
 * First contact: the lead has no Telegram User ID yet, so match through the
 * talk's contact — its Telegram chat carries source_uid == telegram user id.
 */
async function findLeadIdViaTalks(telegramUserId) {
    try {
        const data = await (0, kommo_1.get)('/talks?limit=10');
        const talks = (data?._embedded?.talks ?? [])
            .filter(t => t.entity_type === 'lead' && t.entity_id)
            .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
        const seen = new Set();
        for (const talk of talks) {
            const contactId = talk.contact_id ?? talk._embedded?.contact?.id;
            if (!contactId || seen.has(contactId))
                continue;
            seen.add(contactId);
            const contact = await (0, kommo_1.get)(`/contacts/${contactId}?with=chats`);
            const matched = (contact?._embedded?.chats ?? []).some(c => String(c.source_uid ?? c.external_id ?? '') === String(telegramUserId));
            if (matched)
                return String(talk.entity_id);
        }
    }
    catch (err) {
        console.error('[telegram] talks lookup failed:', (0, env_1.errText)(err));
    }
    return null;
}
async function findLead(telegramUserId) {
    const byField = await findLeadByCustomField(telegramUserId);
    if (byField)
        return { leadId: String(byField.id), lead: byField, via: 'lead-filter' };
    for (let attempt = 1; attempt <= 5; attempt++) {
        const leadId = await findLeadIdViaTalks(telegramUserId);
        if (leadId)
            return { leadId, lead: null, via: 'talks' };
        if (attempt < 5)
            await sleep(2000);
    }
    return null;
}
// ── chat_member updates (channel join / leave) ────────────────────────────────
async function handleChatMember(update) {
    const channelId = (0, env_1.requireEnv)('CHANNEL_ID');
    const chatId = update.chat?.id;
    if (String(chatId) !== String(channelId)) {
        console.log('[telegram] chat_member for other chat:', chatId, '- skipping');
        return;
    }
    const status = update.new_chat_member?.status;
    const telegramUserId = update.new_chat_member?.user?.id ?? update.from?.id;
    if (!telegramUserId || !status) {
        console.warn('[telegram] chat_member without user id or status - skipping');
        return;
    }
    const existing = await (0, supabase_1.getLead)(telegramUserId);
    if (!existing) {
        console.warn('[telegram] chat_member for unknown TG user:', telegramUserId, '| status:', status, '- skipping');
        return;
    }
    const changes = {};
    if (IN_CHANNEL_STATUSES.includes(status)) {
        changes.in_channel = true;
        if (!existing.joined_at)
            changes.joined_at = (0, supabase_1.nowIso)();
    }
    else if (OUT_OF_CHANNEL_STATUSES.includes(status)) {
        changes.in_channel = false;
        changes.left_at = (0, supabase_1.nowIso)();
    }
    else {
        console.log('[telegram] chat_member status ignored:', status, '| TG user:', telegramUserId);
        return;
    }
    await (0, supabase_1.updateLead)(telegramUserId, changes);
    console.log('[telegram] chat_member', status, '| TG user:', telegramUserId);
}
// ── Main handler ──────────────────────────────────────────────────────────────
async function handleTelegramWebhook(req, res) {
    res.status(200).json({ ok: true });
    const body = req.body;
    setImmediate(async () => {
        try {
            // chat_member updates are ours alone - Kommo must not see them
            if (body?.chat_member) {
                await handleChatMember(body.chat_member);
                return;
            }
            const msg = body?.message ?? body?.edited_message;
            const from = msg?.from ?? body?.callback_query?.from;
            const telegramUserId = from?.id;
            const telegramUsername = from?.username;
            const firstName = from?.first_name;
            const lastName = from?.last_name;
            const chatId = msg?.chat?.id ?? from?.id;
            if (!telegramUserId || !chatId) {
                console.warn('[telegram] no from.id - skipping');
                return;
            }
            const msgText = msg?.text ?? '';
            const isStartCommand = msgText === '/start' || msgText.startsWith('/start ');
            let sourcePlatform;
            if (msgText.startsWith('/start ')) {
                const param = msgText.replace('/start ', '').trim().toLowerCase();
                if (param)
                    sourcePlatform = SOURCE_MAP[param] ?? param;
            }
            console.log('[telegram] update | TG user:', telegramUserId, '| start:', isStartCommand, '| source:', sourcePlatform ?? '-');
            // Forward to Kommo (the hook URL carries the bot token - never log it)
            const forwardBody = isStartCommand
                ? { ...body, message: { ...msg, text: 'Hi', entities: undefined } }
                : body;
            try {
                await axios_1.default.post((0, env_1.requireEnv)('KOMMO_TG_WEBHOOK'), forwardBody, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000,
                });
                console.log('[telegram] forwarded to Kommo OK');
            }
            catch (err) {
                console.error('[telegram] forward failed:', (0, env_1.errText)(err));
            }
            const found = await findLead(telegramUserId);
            if (!found) {
                console.warn('[telegram] no lead found for TG user:', telegramUserId);
                return;
            }
            console.log('[telegram] lead resolved via', found.via, '| lead:', found.leadId);
            const lead = found.lead ?? (await (0, kommo_1.get)(`/leads/${found.leadId}?with=tags`));
            const stages = await (0, kommo_1.getStageMap)();
            const stageName = lead ? stages[lead.status_id] : undefined;
            const currentTag = (0, kommo_1.tagNames)(lead?._embedded?.tags);
            // Patch Kommo lead custom fields
            const leadFields = [
                { field_id: kommo_1.LEAD_FIELD.TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
            ];
            if (telegramUsername) {
                leadFields.push({ field_id: kommo_1.LEAD_FIELD.TG_USERNAME, values: [{ value: `@${telegramUsername}` }] });
            }
            if (sourcePlatform) {
                leadFields.push({ field_id: kommo_1.LEAD_FIELD.SOURCE_PLATFORM, values: [{ value: sourcePlatform }] });
            }
            await (0, kommo_1.patch)(`/leads/${found.leadId}`, { custom_fields_values: leadFields });
            console.log('[telegram] Kommo lead patched:', found.leadId);
            // Supabase: insert on first contact, otherwise patch only what changed.
            // original_source_platform and started_at are written once and kept.
            await (0, supabase_1.upsertLead)(telegramUserId, {
                kommo_lead_id: found.leadId,
                telegram_username: telegramUsername ? `@${telegramUsername}` : undefined,
                source_platform: sourcePlatform,
                original_source_platform: sourcePlatform,
                first_name: firstName,
                last_name: lastName,
                current_tag: currentTag,
                kommo_stage: stageName,
                started_at: (0, supabase_1.nowIso)(),
            }, { onlyIfNull: ['original_source_platform', 'started_at'] });
            console.log('[telegram] done | lead:', found.leadId, '| stage:', stageName ?? '-', '| tags:', currentTag ?? '-');
        }
        catch (err) {
            console.error('[telegram] error:', (0, env_1.errText)(err));
        }
    });
}
