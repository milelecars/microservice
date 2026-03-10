"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTelegramWebhook = handleTelegramWebhook;
const axios_1 = __importDefault(require("axios"));
const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
async function handleTelegramWebhook(req, res) {
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        try {
            const body = req.body;
            console.log('[telegram] incoming update:', JSON.stringify(body));
            // Get the real numeric Telegram user ID
            const from = body?.message?.from ?? body?.callback_query?.from;
            const telegramUserId = from?.id;
            if (!telegramUserId) {
                console.warn('[telegram] no from.id in update, skipping');
                return;
            }
            console.log('[telegram] user ID:', telegramUserId);
            // Find the Kommo contact linked to this Telegram user ID
            // by searching talks for a chat linked to this user
            const kommoToken = process.env.KOMMO_TOKEN;
            // Search leads with this telegram user ID already saved
            // OR find via talks — get all talks and match by contact
            // Best approach: search contacts by name or find the active talk
            // We use getUpdates chat.id = telegramUserId to find the Kommo contact
            // Find the lead via talks API — filter by origin telegram
            // and match contact_id to the one that messaged us
            const talksResp = await axios_1.default.get(`${KOMMO_BASE}/talks?limit=50`, { headers: { Authorization: `Bearer ${kommoToken}` }, timeout: 10000 });
            const talks = talksResp.data?._embedded?.talks ?? [];
            // Find the most recent active telegram talk
            const activeTalk = talks
                .filter((t) => t.origin === 'telegram' && t.entity_id && t.entity_type === 'lead')
                .sort((a, b) => b.created_at - a.created_at)[0];
            if (!activeTalk) {
                console.warn('[telegram] no active telegram talk found');
                return;
            }
            const leadId = activeTalk.entity_id;
            const contactId = activeTalk.contact_id;
            console.log('[telegram] matched lead:', leadId, 'contact:', contactId);
            // Save real Telegram user ID to lead field 1067290
            const patchResp = await axios_1.default.patch(`${KOMMO_BASE}/leads/${leadId}`, {
                custom_fields_values: [
                    { field_id: 1067290, values: [{ value: telegramUserId }] }
                ]
            }, {
                headers: { Authorization: `Bearer ${kommoToken}` },
                timeout: 10000,
            });
            console.log('[telegram] saved user ID', telegramUserId, 'to lead', leadId, 'status:', patchResp.status);
        }
        catch (err) {
            console.error('[telegram] error:', err?.response?.data ?? err.message);
        }
    });
}
