"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowIso = nowIso;
exports.getLead = getLead;
exports.queryLeads = queryLeads;
exports.getLeadByKommoLeadId = getLeadByKommoLeadId;
exports.getLeadByKommoContactId = getLeadByKommoContactId;
exports.insertLead = insertLead;
exports.updateLead = updateLead;
exports.diffLead = diffLead;
exports.upsertLead = upsertLead;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../env");
// Never logged, never echoed back — see errText()/redact() in ../env.
function restHeaders() {
    const key = (0, env_1.requireEnv)('SUPABASE_KEY');
    return {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
    };
}
function restUrl(path) {
    return `${(0, env_1.requireEnv)('SUPABASE_URL')}/rest/v1${path}`;
}
function nowIso() {
    return new Date().toISOString();
}
// Get existing lead from Supabase by telegram_user_id
async function getLead(telegramUserId) {
    try {
        const resp = await axios_1.default.get(restUrl(`/founder_circle_members?telegram_user_id=eq.${encodeURIComponent(String(telegramUserId))}&limit=1`), { headers: restHeaders(), timeout: 10000 });
        return resp.data?.[0] ?? null;
    }
    catch (err) {
        console.error('[supabase] getLead failed:', (0, env_1.errText)(err));
        return null;
    }
}
async function getLeadBy(column, value) {
    try {
        const resp = await axios_1.default.get(restUrl(`/founder_circle_members?${column}=eq.${encodeURIComponent(String(value))}&limit=1`), { headers: restHeaders(), timeout: 10000 });
        return resp.data?.[0] ?? null;
    }
    catch (err) {
        console.error(`[supabase] getLeadBy ${column} failed:`, (0, env_1.errText)(err));
        return null;
    }
}
/**
 * Rows matching a raw PostgREST query string, e.g.
 * `link_sent_at=is.null&joined_at=is.null&limit=500`.
 */
async function queryLeads(query) {
    try {
        const resp = await axios_1.default.get(restUrl(`/founder_circle_members?${query}`), {
            headers: restHeaders(),
            timeout: 15000,
        });
        return resp.data ?? [];
    }
    catch (err) {
        console.error('[supabase] queryLeads failed:', (0, env_1.errText)(err));
        return [];
    }
}
/** Row linked to this Kommo lead, if one was linked already. */
async function getLeadByKommoLeadId(leadId) {
    return getLeadBy('kommo_lead_id', leadId);
}
/** Row linked to this Kommo contact, if one was linked already. */
async function getLeadByKommoContactId(contactId) {
    return getLeadBy('kommo_contact_id', contactId);
}
// Insert new lead (only on first contact)
async function insertLead(data) {
    try {
        const resp = await axios_1.default.post(restUrl('/founder_circle_members'), data, {
            headers: { ...restHeaders(), Prefer: 'return=minimal' },
            timeout: 10000,
        });
        console.log('[supabase] inserted lead:', data.kommo_lead_id, '| TG user:', data.telegram_user_id, '| status:', resp.status);
    }
    catch (err) {
        console.error('[supabase] insert failed:', (0, env_1.errText)(err));
    }
}
// Partial update — only send fields that actually changed, keyed by telegram_user_id
async function updateLead(telegramUserId, changes) {
    if (Object.keys(changes).length === 0) {
        console.log('[supabase] no changes for TG user:', telegramUserId, '— skipping');
        return;
    }
    try {
        const resp = await axios_1.default.patch(restUrl(`/founder_circle_members?telegram_user_id=eq.${encodeURIComponent(String(telegramUserId))}`), changes, { headers: { ...restHeaders(), Prefer: 'return=minimal' }, timeout: 10000 });
        console.log('[supabase] updated TG user:', telegramUserId, '| fields:', Object.keys(changes).join(', '), '| status:', resp.status);
    }
    catch (err) {
        console.error('[supabase] update failed:', (0, env_1.errText)(err));
    }
}
/**
 * The subset of `data` that would actually change the row. Keys listed in
 * `onlyIfNull` are dropped when the row already holds a value for them.
 */
function diffLead(existing, data, onlyIfNull = []) {
    const changes = {};
    for (const key of Object.keys(data)) {
        const value = data[key];
        if (value === undefined)
            continue;
        if (onlyIfNull.includes(key) && existing[key] !== null && existing[key] !== undefined)
            continue;
        if (existing[key] === value)
            continue;
        Object.assign(changes, { [key]: value });
    }
    return changes;
}
/**
 * Insert the row on first contact, otherwise PATCH only the fields that changed.
 * Returns the row as it was before the write (null when it was just created).
 */
async function upsertLead(telegramUserId, data, opts = {}) {
    const existing = await getLead(telegramUserId);
    if (!existing) {
        const record = {
            ...opts.insertOnly,
            ...data,
            telegram_user_id: telegramUserId,
        };
        for (const key of Object.keys(record)) {
            if (record[key] === undefined)
                delete record[key];
        }
        await insertLead(record);
        return null;
    }
    await updateLead(telegramUserId, diffLead(existing, data, opts.onlyIfNull ?? []));
    return existing;
}
