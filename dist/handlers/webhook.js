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
                const authorId = msg.author?.id ?? msg.author_id;
                const leadId = msg.entity_id ?? msg.element_id;
                console.log('[webhook] message event:', { authorId, leadId });
                // author_id here is an amojo UUID, not a real Telegram ID.
                // Real ID comes from /webhook/telegram instead.
                // This is just a fallback — skip if no leadId.
                if (!authorId || !leadId)
                    continue;
                const kommoToken = process.env.KOMMO_TOKEN;
                try {
                    const patchResp = await axios_1.default.patch(`${KOMMO_BASE}/leads/${leadId}`, {
                        custom_fields_values: [
                            { field_id: 1067290, values: [{ value: authorId }] }
                        ]
                    }, {
                        headers: { Authorization: `Bearer ${kommoToken}` },
                        timeout: 10000,
                    });
                    console.log('[webhook] patched lead', leadId, 'status:', patchResp.status);
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
