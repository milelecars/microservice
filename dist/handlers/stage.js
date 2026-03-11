"use strict";
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
            // Update only the stage in Supabase
            await (0, supabase_1.updateLead)(leadId, { kommo_stage: stageName });
        }
        catch (err) {
            console.error('[stage] error:', err?.response?.data ?? err.message);
        }
    });
}
