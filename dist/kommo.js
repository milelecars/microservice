"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTACT_FIELD = exports.LEAD_FIELD = exports.STAGE = exports.PIPELINE_ID = exports.KOMMO_BASE = void 0;
exports.get = get;
exports.patch = patch;
exports.getStageMap = getStageMap;
exports.fieldValue = fieldValue;
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
/** Custom fields on the CONTACT, written by the Salesbot. */
exports.CONTACT_FIELD = {
    PHONE: 1003178, // multitext, enum WORK
    EMAIL: 1003180, // multitext, enum WORK
    COUNTRY: 1383512,
    AGE: 1383508,
    INTEREST: 1383510,
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
// ── Field helpers ─────────────────────────────────────────────────────────────
/** First value of a custom field, as a trimmed string. */
function fieldValue(fields, fieldId) {
    const raw = fields?.find(f => f.field_id === fieldId)?.values?.[0]?.value;
    if (raw === undefined || raw === null)
        return undefined;
    const text = String(raw).trim();
    return text.length > 0 ? text : undefined;
}
/** Tag names joined by comma, or undefined when the entity has no tags. */
function tagNames(tags) {
    const names = (tags ?? []).map(t => t.name).filter(Boolean);
    return names.length > 0 ? names.join(', ') : undefined;
}
function hasTag(tags, name) {
    return (tags ?? []).some(t => t.name?.toLowerCase() === name.toLowerCase());
}
