import { Request, Response } from 'express';
import axios from 'axios';
import { getLead, insertLead, updateLead, LeadRecord } from './supabase';

const KOMMO_BASE  = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;

const FIELD_TG_USER_ID      = 1067290;
const FIELD_TG_USERNAME     = 1104292;
const FIELD_SOURCE_PLATFORM = 1094948;

const KOMMO_TG_WEBHOOK = 'https://amojo.amocrm.com/~external/hooks/telegram?t=8593034950:AAG7lU1tK8XJWTIbVSHyeFHFwggzDiJD8Rk&';

const SOURCE_MAP: Record<string, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', direct: 'Direct',
};

// Cache stage map after first load
let stageMap: Record<number, string> = {};
let stageMapLoaded = false;

async function getStageMap(): Promise<Record<number, string>> {
  if (stageMapLoaded) return stageMap;
  try {
    const resp = await axios.get(
      `${KOMMO_BASE}/leads/pipelines`,
      { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
    );
    for (const pipeline of resp.data?._embedded?.pipelines ?? []) {
      for (const stage of pipeline._embedded?.statuses ?? []) {
        stageMap[stage.id] = stage.name;
      }
    }
    stageMapLoaded = true;
    console.log('[telegram] stage map loaded:', JSON.stringify(stageMap));
  } catch (err: any) {
    console.error('[telegram] failed to load stage map:', err.message);
  }
  return stageMap;
}

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[telegram] incoming update:', JSON.stringify(body));

      const msg  = body?.message ?? body?.edited_message;
      const from = msg?.from ?? body?.callback_query?.from;

      const telegramUserId: number | undefined = from?.id;
      const telegramUsername: string | undefined = from?.username;
      const firstName: string | undefined = from?.first_name;
      const lastName: string | undefined = from?.last_name;
      const chatId: number | undefined = msg?.chat?.id ?? from?.id;

      if (!telegramUserId || !chatId) {
        console.warn('[telegram] no from.id — skipping');
        return;
      }

      const msgText: string = msg?.text ?? '';
      const isStartCommand = msgText === '/start' || msgText.startsWith('/start ');

      let sourcePlatform: string | undefined;
      if (msgText.startsWith('/start ')) {
        const param = msgText.replace('/start ', '').trim().toLowerCase();
        sourcePlatform = SOURCE_MAP[param] ?? param;
      }

      // Forward to Kommo
      const forwardBody = isStartCommand
        ? { ...body, message: { ...msg, text: 'Hi', entities: undefined } }
        : body;

      axios.post(KOMMO_TG_WEBHOOK, forwardBody, {
        headers: { 'Content-Type': 'application/json' }, timeout: 10_000,
      })
        .then(() => console.log('[telegram] forwarded to Kommo ✓'))
        .catch(err => console.error('[telegram] forward failed:', err.message));

      await new Promise(r => setTimeout(r, 3000));

      // Find lead via talks
      const talksResp = await axios.get(
        `${KOMMO_BASE}/talks?limit=5`,
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );
      const talks: any[] = talksResp.data?._embedded?.talks ?? [];
      const activeTalk = talks
        .filter(t => t.origin === 'telegram' && t.entity_id && t.entity_type === 'lead')
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!activeTalk) { console.warn('[telegram] no active talk found'); return; }

      const leadId = String(activeTalk.entity_id);

      // Fetch lead for stage + tags
      const [leadResp, stages] = await Promise.all([
        axios.get(`${KOMMO_BASE}/leads/${leadId}?with=tags`, {
          headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000,
        }),
        getStageMap(),
      ]);

      const statusId: number   = leadResp.data?.status_id;
      const stageName           = stages[statusId];
      const existingTags        = leadResp.data?._embedded?.tags ?? [];
      const currentTag          = existingTags.map((t: any) => t.name).join(', ') || undefined;

      // Patch Kommo custom fields
      const leadFields: any[] = [
        { field_id: FIELD_TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
      ];
      if (telegramUsername) leadFields.push({ field_id: FIELD_TG_USERNAME, values: [{ value: `@${telegramUsername}` }] });
      if (sourcePlatform)   leadFields.push({ field_id: FIELD_SOURCE_PLATFORM, values: [{ value: sourcePlatform }] });

      await axios.patch(`${KOMMO_BASE}/leads/${leadId}`, { custom_fields_values: leadFields }, {
        headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000,
      });
      console.log('[telegram] Kommo lead patched');

      // ── Supabase: insert or update only changed fields (keyed by telegram_user_id) ─
      const existing = await getLead(Number(telegramUserId));

      if (!existing) {
        // New user — insert full record
        await insertLead({
          kommo_lead_id:            leadId,
          telegram_user_id:         Number(telegramUserId),
          telegram_username:        telegramUsername ? `@${telegramUsername}` : undefined,
          source_platform:          sourcePlatform,
          first_name:               firstName,
          last_name:                lastName,
          current_tag:              currentTag,
          kommo_stage:              stageName,
        });
      } else {
        // Returning user — update only fields that changed
        const changes: Partial<LeadRecord> = {};
        // Always update kommo_lead_id in case they have a new conversation
        if (existing.kommo_lead_id !== leadId)                                          changes.kommo_lead_id     = leadId;
        if (telegramUsername && existing.telegram_username !== `@${telegramUsername}`)  changes.telegram_username = `@${telegramUsername}`;
        if (sourcePlatform   && existing.source_platform   !== sourcePlatform)          changes.source_platform   = sourcePlatform;
        if (firstName        && existing.first_name        !== firstName)               changes.first_name        = firstName;
        if (lastName         && existing.last_name         !== lastName)                changes.last_name         = lastName;
        if (currentTag       && existing.current_tag       !== currentTag)              changes.current_tag       = currentTag;
        if (stageName        && existing.kommo_stage       !== stageName)               changes.kommo_stage       = stageName;
        await updateLead(Number(telegramUserId), changes);
      }

      console.log('[telegram] ✓ done | lead:', leadId, '| stage:', stageName, '| tags:', currentTag);

    } catch (err: any) {
      console.error('[telegram] error:', err?.response?.data ?? err.message);
    }
  });
}