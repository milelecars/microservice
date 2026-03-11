"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleStageChange = handleStageChange;
const axios_1 = __importDefault(require("axios"));
const supabase_1 = require("./supabase");
const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
// Cache stage map
let stageMap = {};
let stageMapLoaded = false;
async function getStageMap() {
    if (stageMapLoaded)
        return stageMap;
    try {
        const resp = await axios_1.default.get(`${KOMMO_BASE}/leads/pipelines`, { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10000 });
        for (const pipeline of resp.data?._embedded?.pipelines ?? []) {
            for (const stage of pipeline._embedded?.statuses ?? []) {
                stageMap[stage.id] = stage.name;
            }
        }
        stageMapLoaded = true;
    }
    catch (err) {
        console.error('[stage] failed to load stage map:', err.message);
    }
    return stageMap;
}
// This route is called by Kommo Digital Pipeline webhook on stage change
async function handleStageChange(req, res) {
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        try {
            const body = req.body;
            console.log('[stage] incoming payload:', JSON.stringify(body));
            // Kommo pipeline webhook sends leads.add or leads.update
            const lead = body?.leads?.add?.[0] ??
                body?.leads?.update?.[0];
            if (!lead) {
                console.warn('[stage] no lead in payload — skipping');
                return;
            }
            const leadId = String(lead.id);
            const statusId = Number(lead.status_id);
            const stages = await getStageMap();
            const stageName = stages[statusId];
            if (!stageName) {
                console.warn('[stage] unknown status_id:', statusId);
                return;
            }
            console.log('[stage] lead:', leadId, '→ stage:', stageName);
            // Look up TG user ID from Kommo lead to update Supabase by telegram_user_id
            const leadResp = await axios_1.default.get(`${KOMMO_BASE}/leads/${leadId}`, { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10000 });
            const tgUserId = leadResp.data?.custom_fields_values
                ?.find((f) => f.field_id === 1067290)?.values?.[0]?.value;
            if (!tgUserId) {
                console.warn('[stage] no TG user ID on lead — skipping Supabase update');
                return;
            }
            // Base update — always sync stage
            const changes = { kommo_stage: stageName, kommo_lead_id: leadId };
            // Set original_source_platform ONCE when lead reaches Pending Registration
            const PENDING_STAGE = 'pending registeration'; // match your exact Kommo stage name (case-insensitive)
            if (stageName.toLowerCase() === PENDING_STAGE) {
                // Fetch current Supabase record to check if original_source_platform already set
                const { getLead } = await Promise.resolve().then(() => __importStar(require('./supabase')));
                const existing = await getLead(Number(tgUserId));
                if (existing && !existing.original_source_platform && existing.source_platform) {
                    changes.original_source_platform = existing.source_platform;
                    console.log('[stage] setting original_source_platform:', existing.source_platform, '→ TG user:', tgUserId);
                }
                else {
                    console.log('[stage] original_source_platform already set or no source — skipping');
                }
            }
            await (0, supabase_1.updateLead)(Number(tgUserId), changes);
        }
        catch (err) {
            console.error('[stage] error:', err?.response?.data ?? err.message);
        }
    });
}
