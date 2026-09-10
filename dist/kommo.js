"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTACT_FIELD = exports.LEAD_FIELD = exports.STAGE = exports.PIPELINE_ID = exports.KOMMO_BASE = void 0;
exports.get = get;
exports.patch = patch;
exports.post = post;
exports.contactStatusFor = contactStatusFor;
exports.setContactStatus = setContactStatus;
exports.closeTalk = closeTalk;
exports.addLeadTags = addLeadTags;
exports.getStageMap = getStageMap;
exports.resolveTelegramUserId = resolveTelegramUserId;
exports.fieldValue = fieldValue;
exports.fieldValueLast = fieldValueLast;
exports.tagNames = tagNames;
exports.hasTag = hasTag;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("./env");
exports.KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
/** Founder Circle pipeline. */
exports.PIPELINE_ID = 13228919;
/** Pipeline stages, by status id. */
exports.STAGE = {
    INCOMING_LEADS: 102006055,
    IN_CONVERSATION: 102006151, // "In Converstation" in Kommo
    JOINED_CHANNEL: 111366003,
    PENDING_REGISTERATION: 102006155,
    PENDING_VERIFICATION: 102006159,
    PENDING_FTD: 102006163,
    UPSELL: 102006167,
    LOST: 102006171,
};
/** Custom fields on the LEAD. */
exports.LEAD_FIELD = {
    TG_USER_ID: 1067290,
    TG_USERNAME: 1104292,
    SOURCE_PLATFORM: 1094948,
};
/**
 * Custom fields on the CONTACT. Only STATUS is written now — the greeting-only
 * bot asks nothing, so the answer fields are left for the rows that already
 * hold answers from the question era.
 */
exports.CONTACT_FIELD = {
    STATUS: 1003176, // funnel status: "joined" / "link sent" / empty
    PHONE: 1003178, // multitext, enum WORK        (legacy, no longer written)
    EMAIL: 1003180, // multitext, enum WORK        (legacy, no longer written)
    COUNTRY: 1383512, //                             (legacy, no longer written)
    AGE: 1383508, //                             (legacy, no longer written)
    INTEREST: 1383510, //                             (legacy, no longer written)
};
// ── HTTP ──────────────────────────────────────────────────────────────────────
function authHeaders() {
    return { Authorization: `Bearer ${(0, env_1.requireEnv)('KOMMO_TOKEN')}` };
}
/** GET a Kommo API path. Returns null on 204 (Kommo's "empty result"). */
async function get(path) {
    const resp = await axios_1.default.get(`${exports.KOMMO_BASE}${path}`, {
        headers: authHeaders(),
        timeout: 10000,
        validateStatus: s => (s >= 200 && s < 300) || s === 204,
    });
    if (resp.status === 204)
        return null;
    return resp.data ?? null;
}
/** PATCH a Kommo API path. */
async function patch(path, body) {
    const resp = await axios_1.default.patch(`${exports.KOMMO_BASE}${path}`, body, {
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        timeout: 10000,
    });
    return resp.data ?? null;
}
/** POST to a Kommo API path. */
async function post(path, body) {
    const resp = await axios_1.default.post(`${exports.KOMMO_BASE}${path}`, body, {
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        timeout: 10000,
    });
    return resp.data ?? null;
}
/**
 * Where this person stands, as contact field 1003176 spells it. The greeting
 * sends the card straight away, so "link sent" covers everyone who has pressed
 * Start and is not in the channel yet.
 */
function contactStatusFor(row) {
    if (row.joined_at || row.in_channel)
        return 'joined';
    if (row.link_sent_at)
        return 'link sent';
    return '';
}
/**
 * Mirror where the person stands onto the contact, so Kommo and Supabase never
 * disagree. An empty value clears the field.
 */
async function setContactStatus(contactId, value) {
    try {
        await patch(`/contacts/${contactId}`, {
            custom_fields_values: [{ field_id: exports.CONTACT_FIELD.STATUS, values: [{ value }] }],
        });
        console.log('[status] contact', contactId, 'set to', value === '' ? '""' : value);
        return true;
    }
    catch (err) {
        console.error('[status] contact', contactId, 'update failed:', (0, env_1.errText)(err));
        return false;
    }
}
// ── Talks ─────────────────────────────────────────────────────────────────────
/** Kommo's two ways of saying the talk is not open: gone, or already closed. */
function alreadyClosed(err) {
    if (!axios_1.default.isAxiosError(err))
        return false;
    const status = err.response?.status;
    if (status === 404)
        return true;
    const detail = String(err.response?.data?.detail ?? '');
    return status === 422 && /closed/i.test(detail);
}
/**
 * Close a Kommo talk so the next Telegram message starts a fresh conversation.
 * A 404, or a 422 saying the talk is closed, is the state we wanted anyway.
 */
async function closeTalk(talkId, telegramUserId) {
    try {
        await post(`/talks/${talkId}/close`, { force_close: true });
        console.log('[talk] closed', talkId, 'for TG', telegramUserId);
        return true;
    }
    catch (err) {
        if (alreadyClosed(err)) {
            console.log('[talk]', talkId, 'already closed for TG', telegramUserId);
            return true;
        }
        console.error('[talk] close failed', talkId, 'for TG', telegramUserId, '|', (0, env_1.errText)(err));
        return false;
    }
}
// ── Lead tags ─────────────────────────────────────────────────────────────────
/**
 * Add tags to a lead without touching the ones it already has. The current tags
 * are read first so a name already on the lead is left alone, and the write goes
 * through `tags_to_add`, which appends — nothing else can be dropped by a stale
 * read. Returns the names that were actually added.
 */
async function addLeadTags(leadId, names) {
    try {
        const lead = await get(`/leads/${leadId}?with=tags`);
        const existing = lead?._embedded?.tags ?? [];
        const missing = names.filter(name => !hasTag(existing, name));
        if (missing.length === 0)
            return [];
        await patch(`/leads/${leadId}`, { tags_to_add: missing.map(name => ({ name })) });
        return missing;
    }
    catch (err) {
        console.error('[kommo] addLeadTags failed for lead', leadId, '|', (0, env_1.errText)(err));
        return [];
    }
}
// ── Stage map (cached after first successful load) ─────────────────────────────
let stageMap = {};
let stageMapLoaded = false;
async function getStageMap() {
    if (stageMapLoaded)
        return stageMap;
    try {
        const data = await get('/leads/pipelines');
        const next = {};
        for (const pipeline of data?._embedded?.pipelines ?? []) {
            for (const stage of pipeline._embedded?.statuses ?? []) {
                next[stage.id] = stage.name;
            }
        }
        if (Object.keys(next).length > 0) {
            stageMap = next;
            stageMapLoaded = true;
            console.log('[kommo] stage map loaded:', Object.keys(stageMap).length, 'stages');
        }
    }
    catch (err) {
        console.error('[kommo] failed to load stage map:', (0, env_1.errText)(err));
    }
    return stageMap;
}
// ── Telegram identity ─────────────────────────────────────────────────────────
/**
 * Discover the Telegram user id from a contact's chats — a Telegram chat's
 * source_uid IS the Telegram user id. Returns undefined when the contact has
 * no Telegram chat yet.
 */
async function resolveTelegramUserId(contactId) {
    try {
        const contact = await get(`/contacts/${contactId}?with=chats`);
        const chats = contact?._embedded?.chats ?? [];
        const tgChat = chats.find(c => c.origin?.toLowerCase() === 'telegram' || c.channel_type?.toLowerCase() === 'telegram') ??
            chats.find(c => !!(c.source_uid ?? c.external_id));
        if (!tgChat) {
            console.log('[kommo] no telegram chat for contact:', contactId, '| chats:', chats.length);
            return undefined;
        }
        const uid = String(tgChat.source_uid ?? tgChat.external_id ?? '').trim();
        return uid.length > 0 ? uid : undefined;
    }
    catch (err) {
        console.error('[kommo] resolveTelegramUserId failed for contact:', contactId, '|', (0, env_1.errText)(err));
        return undefined;
    }
}
// ── Field helpers ─────────────────────────────────────────────────────────────
function pickValue(fields, fieldId, which) {
    const values = fields?.find(f => f.field_id === fieldId)?.values ?? [];
    const picked = which === 'last' ? values[values.length - 1] : values[0];
    const raw = picked?.value;
    if (raw === undefined || raw === null)
        return undefined;
    const text = String(raw).trim();
    return text.length > 0 ? text : undefined;
}
/** First value of a custom field, as a trimmed string. */
function fieldValue(fields, fieldId) {
    return pickValue(fields, fieldId, 'first');
}
/**
 * Last value of a custom field — multitext fields such as Phone and Email keep
 * every value the Salesbot has written, and the newest one is the current one.
 */
function fieldValueLast(fields, fieldId) {
    return pickValue(fields, fieldId, 'last');
}
/** Tag names joined by comma, or undefined when the entity has no tags. */
function tagNames(tags) {
    const names = (tags ?? []).map(t => t.name).filter(Boolean);
    return names.length > 0 ? names.join(', ') : undefined;
}
function hasTag(tags, name) {
    return (tags ?? []).some(t => t.name?.toLowerCase() === name.toLowerCase());
}
