"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertLead = upsertLead;
exports.updateLeadTag = updateLeadTag;
const axios_1 = __importDefault(require("axios"));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'resolution=merge-duplicates',
};
async function upsertLead(data) {
    try {
        const resp = await axios_1.default.post(`${SUPABASE_URL}/rest/v1/leads`, data, { headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, timeout: 10000 });
        console.log('[supabase] upserted lead:', data.kommo_lead_id, '| status:', resp.status);
    }
    catch (err) {
        console.error('[supabase] upsert failed:', err?.response?.data ?? err.message);
    }
}
async function updateLeadTag(kommoLeadId, tag) {
    try {
        const resp = await axios_1.default.patch(`${SUPABASE_URL}/rest/v1/leads?kommo_lead_id=eq.${kommoLeadId}`, { current_tag: tag }, { headers: { ...headers, 'Prefer': 'return=minimal' }, timeout: 10000 });
        console.log('[supabase] tag updated:', tag, '→ lead:', kommoLeadId, '| status:', resp.status);
    }
    catch (err) {
        console.error('[supabase] tag update failed:', err?.response?.data ?? err.message);
    }
}
