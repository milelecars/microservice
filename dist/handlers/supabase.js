"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLead = getLead;
exports.insertLead = insertLead;
exports.updateLead = updateLead;
const axios_1 = __importDefault(require("axios"));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
};
// Get existing lead from Supabase by telegram_user_id
async function getLead(telegramUserId) {
    try {
        const resp = await axios_1.default.get(`${SUPABASE_URL}/rest/v1/leads?telegram_user_id=eq.${telegramUserId}&limit=1`, { headers, timeout: 10000 });
        return resp.data?.[0] ?? null;
    }
    catch (err) {
        console.error('[supabase] getLead failed:', err?.response?.data ?? err.message);
        return null;
    }
}
// Insert new lead (only on first contact)
async function insertLead(data) {
    try {
        const resp = await axios_1.default.post(`${SUPABASE_URL}/rest/v1/leads`, data, { headers: { ...headers, 'Prefer': 'return=minimal' }, timeout: 10000 });
        console.log('[supabase] inserted lead:', data.kommo_lead_id, '| status:', resp.status);
    }
    catch (err) {
        console.error('[supabase] insert failed:', err?.response?.data ?? err.message);
    }
}
// Partial update — only send fields that actually changed, keyed by telegram_user_id
async function updateLead(telegramUserId, changes) {
    if (Object.keys(changes).length === 0) {
        console.log('[supabase] no changes for TG user:', telegramUserId, '— skipping');
        return;
    }
    try {
        const resp = await axios_1.default.patch(`${SUPABASE_URL}/rest/v1/leads?telegram_user_id=eq.${telegramUserId}`, changes, { headers: { ...headers, 'Prefer': 'return=minimal' }, timeout: 10000 });
        console.log('[supabase] updated TG user:', telegramUserId, '| changes:', JSON.stringify(changes), '| status:', resp.status);
    }
    catch (err) {
        console.error('[supabase] update failed:', err?.response?.data ?? err.message);
    }
}
