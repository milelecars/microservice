"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDeposited = verifyDeposited;
const weex_1 = require("../weex");
const callback_1 = require("../callback");
async function verifyDeposited(req, res) {
    const { return_url, data } = req.body;
    const traderId = data?.trader_id;
    console.log('[deposited] received', { traderId, return_url });
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        const kommoToken = process.env.KOMMO_TOKEN;
        if (!return_url) {
            console.error('[deposited] missing return_url');
            return;
        }
        if (!traderId) {
            await (0, callback_1.resumeBot)(return_url, 'no_deposit', kommoToken, 'No Trader ID provided');
            return;
        }
        try {
            const trader = await (0, weex_1.getTraderByUid)(String(traderId));
            if (!trader) {
                await (0, callback_1.resumeBot)(return_url, 'no_deposit', kommoToken, 'Trader ID not found');
                return;
            }
            const hasDeposit = !!trader.firstDeposit && trader.firstDeposit.trim().length > 0;
            if (hasDeposit) {
                const depositDate = new Date(parseInt(trader.firstDeposit, 10)).toLocaleDateString();
                await (0, callback_1.resumeBot)(return_url, 'deposited', kommoToken, `First deposit on ${depositDate}`);
            }
            else {
                await (0, callback_1.resumeBot)(return_url, 'no_deposit', kommoToken, 'No deposit detected yet');
            }
        }
        catch (err) {
            console.error('[deposited] Weex API error:', err);
            await (0, callback_1.resumeBot)(return_url, 'error', kommoToken, 'Verification service temporarily unavailable');
        }
    });
}
