"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyRegistered = verifyRegistered;
const weex_1 = require("../weex");
const callback_1 = require("../callback");
async function verifyRegistered(req, res) {
    const rawData = req.body.data;
    const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    const traderId = data?.trader_id;
    const { return_url } = req.body;
    const leadId = data?.lead_id;
    console.log('[registered] received', { traderId, return_url });
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        const kommoToken = process.env.KOMMO_TOKEN;
        if (!return_url) {
            console.error('[registered] missing return_url');
            return;
        }
        if (!traderId) {
            await (0, callback_1.resumeBot)(return_url, 'not_found', kommoToken, 'No Trader ID provided');
            return;
        }
        try {
            const trader = await (0, weex_1.getTraderByUid)(String(traderId));
            if (!trader) {
                await (0, callback_1.resumeBot)(return_url, 'not_found', kommoToken, 'Trader ID not found under this affiliate account');
                return;
            }
            await (0, callback_1.resumeBot)(return_url, 'verified', kommoToken, 'Registration confirmed');
        }
        catch (err) {
            console.error('[registered] Weex API error:', err);
            await (0, callback_1.resumeBot)(return_url, 'error', kommoToken, 'Verification service temporarily unavailable');
        }
    });
}
