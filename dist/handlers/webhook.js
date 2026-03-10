"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleNewMessage = handleNewMessage;
const axios_1 = __importDefault(require("axios"));
const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
async function handleNewMessage(req, res) {
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        try {
            const body = req.body;
            console.log('[webhook] incoming payload:', JSON.stringify(body));
            const messages = body?.message?.add ?? body?.message?.update ?? [];
            for (const msg of messages) {
                if (msg.type !== 'incoming')
                    continue;
                const telegramUserId = msg.author_id;
                const contactId = msg.contact_id;
                console.log('[webhook] message event:', { telegramUserId, contactId });
                if (!telegramUserId || !contactId)
                    continue;
                const kommoToken = process.env.KOMMO_TOKEN;
                const numericId = Number(telegramUserId);
                const valueToSend = Number.isFinite(numericId) ? numericId : telegramUserId;
                console.log('[webhook] patching contact', contactId, 'with value:', valueToSend, typeof valueToSend);
                try {
                    const patchResp = await axios_1.default.patch(`${KOMMO_BASE}/contacts/${contactId}`, {
                        custom_fields_values: [
                            { field_id: 1067290, values: [{ value: valueToSend }] }
                        ]
                    }, {
                        headers: { Authorization: `Bearer ${kommoToken}` },
                        timeout: 10000,
                    });
                    console.log('[webhook] patch response:', patchResp.status, JSON.stringify(patchResp.data?._embedded?.contacts?.[0]?.custom_fields_values?.find((f) => f.field_id === 1067290)));
                    console.log('[webhook] saved Telegram user ID', telegramUserId, 'to contact', contactId);
                }
                catch (patchErr) {
                    console.error('[webhook] patch failed:', JSON.stringify(patchErr?.response?.data));
                }
            }
        }
        catch (err) {
            console.error('[webhook] error:', err?.response?.data ?? err.message);
        }
    });
}
