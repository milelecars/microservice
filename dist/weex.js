"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTraderByUid = getTraderByUid;
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
// ── Signature ─────────────────────────────────────────────────────────────────
function sign(secretKey, timestamp, queryString) {
    const requestPath = '/api/v2/rebate/affiliate/getAffiliateUIDs';
    const message = `${timestamp}GET${requestPath}?${queryString}`;
    return crypto_1.default.createHmac('sha256', secretKey).update(message, 'utf8').digest('base64');
}
// ── Lookup ────────────────────────────────────────────────────────────────────
async function getTraderByUid(uid) {
    const { WEEX_API_KEY, WEEX_SECRET_KEY, WEEX_PASSPHRASE } = process.env;
    if (!WEEX_API_KEY || !WEEX_SECRET_KEY || !WEEX_PASSPHRASE) {
        throw new Error('Missing Weex env vars');
    }
    const timestamp = String(Date.now());
    const qp = new URLSearchParams({ uid, pageSize: '1' });
    const queryString = qp.toString();
    const response = await axios_1.default.get('https://api-spot.weex.com/api/v2/rebate/affiliate/getAffiliateUIDs', {
        params: Object.fromEntries(qp),
        headers: {
            'ACCESS-KEY': WEEX_API_KEY,
            'ACCESS-SIGN': sign(WEEX_SECRET_KEY, timestamp, queryString),
            'ACCESS-PASSPHRASE': WEEX_PASSPHRASE,
            'ACCESS-TIMESTAMP': timestamp,
            'Content-Type': 'application/json',
            'locale': 'en-US',
        },
        timeout: 15000,
    });
    if (response.data.code !== '200') {
        throw new Error(`Weex API error: ${response.data.code}`);
    }
    const list = response.data.data?.channelUserInfoItemList ?? [];
    return list.find(u => u.uid === uid) ?? null;
}
