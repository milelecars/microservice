"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyChannel = verifyChannel;
const axios_1 = __importDefault(require("axios"));
const callback_1 = require("../callback");
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const identity_1 = require("./identity");
const supabase_1 = require("./supabase");
async function syncJoined(telegramUserId) {
    const existing = await (0, supabase_1.getLead)(telegramUserId);
    if (!existing) {
        console.warn('[channel] no Supabase row for TG user:', telegramUserId, '- skipping sync');
        return;
    }
    const changes = { in_channel: true };
    if (!existing.joined_at)
        changes.joined_at = (0, supabase_1.nowIso)();
    await (0, supabase_1.updateLead)(telegramUserId, changes);
}
async function syncNotJoined(telegramUserId) {
    const existing = await (0, supabase_1.getLead)(telegramUserId);
    if (!existing) {
        console.warn('[channel] no Supabase row for TG user:', telegramUserId, '- skipping sync');
        return;
    }
    await (0, supabase_1.updateLead)(telegramUserId, {
        in_channel: false,
        join_check_failures: (existing.join_check_failures ?? 0) + 1,
    });
}
async function verifyChannel(req, res) {
    const { return_url } = req.body;
    const rawData = req.body?.data;
    let data;
    if (typeof rawData === 'string') {
        try {
            data = JSON.parse(rawData);
        }
        catch (e) {
            console.error('[channel] failed to parse body.data JSON', { error: (0, env_1.errText)(e) });
            data = undefined;
        }
    }
    else {
        data = rawData;
    }
    const leadId = data?.lead_id;
    console.log('[channel] received', {
        returnUrlPresent: !!return_url,
        rawDataType: rawData === null ? 'null' : Array.isArray(rawData) ? 'array' : typeof rawData,
        leadId,
        bodyKeys: Object.keys(req.body ?? {}).slice(0, 30),
    });
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        const kommoToken = process.env.KOMMO_TOKEN;
        const botToken = process.env.BOT_TOKEN;
        const channelId = process.env.CHANNEL_ID;
        if (!kommoToken || !botToken || !channelId) {
            console.error('[channel] missing env vars');
            await (0, callback_1.resumeBot)(return_url, 'not_joined', kommoToken, 'Server config error');
            return;
        }
        try {
            if (!return_url) {
                console.error('[channel] missing return_url');
                return;
            }
            if (!leadId) {
                console.error('[channel] missing lead_id in data');
                await (0, callback_1.resumeBot)(return_url, 'error', kommoToken, 'Missing lead_id');
                return;
            }
            // ── Step 1: resolve the Telegram user id ──────────────────────────────
            const lead = await (0, kommo_1.get)(`/leads/${leadId}?with=contacts`);
            const contacts = lead?._embedded?.contacts ?? [];
            const mainContact = contacts.find(c => c.is_main) ?? contacts[0];
            const contactId = mainContact?.id;
            console.log('[channel] contactId:', contactId);
            const { telegramUserId, row, via } = await (0, identity_1.resolveTelegramId)('[channel]', lead, leadId, contactId);
            console.log('[channel] telegramUserId:', telegramUserId ?? '-', '| via:', via);
            if (!telegramUserId) {
                console.error('[channel] could not resolve Telegram user ID');
                await (0, callback_1.resumeBot)(return_url, 'not_joined', kommoToken, 'Could not resolve Telegram user ID');
                return;
            }
            // ── Step 2: save it onto the LEAD when the field was empty ────────────
            if (via !== 'lead-field') {
                await (0, kommo_1.patch)(`/leads/${leadId}`, {
                    custom_fields_values: [
                        { field_id: kommo_1.LEAD_FIELD.TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
                    ],
                });
                console.log('[channel] saved telegramUserId to lead field:', telegramUserId);
            }
            // ── Step 3: chat_member already told us they are in ───────────────────
            const existing = row ?? (await (0, supabase_1.getLead)(telegramUserId));
            if (existing?.in_channel) {
                console.log('[channel] in_channel already true - answering joined | TG user:', telegramUserId);
                if (!existing.joined_at)
                    await (0, supabase_1.updateLead)(telegramUserId, { joined_at: (0, supabase_1.nowIso)() });
                await (0, callback_1.resumeBot)(return_url, 'joined', kommoToken, 'Channel membership confirmed');
                return;
            }
            // ── Step 4: check channel membership ──────────────────────────────────
            const tgResp = await axios_1.default.get('https://api.telegram.org/bot' + botToken + '/getChatMember', { params: { chat_id: channelId, user_id: telegramUserId }, timeout: 10000 });
            const status = tgResp.data?.result?.status;
            console.log('[channel] getChatMember status:', status, 'for user:', telegramUserId);
            const isJoined = ['member', 'administrator', 'creator'].includes(status ?? '');
            if (isJoined)
                await syncJoined(telegramUserId);
            else
                await syncNotJoined(telegramUserId);
            await (0, callback_1.resumeBot)(return_url, isJoined ? 'joined' : 'not_joined', kommoToken, isJoined ? 'Channel membership confirmed' : 'User has not joined the channel');
        }
        catch (err) {
            console.error('[channel] error:', (0, env_1.errText)(err));
            await (0, callback_1.resumeBot)(return_url, 'error', kommoToken, (0, env_1.errText)(err));
        }
    });
}
