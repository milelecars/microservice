import axios from 'axios';
import { requireEnv, errText } from '../env';

const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'chat_member'];

interface TelegramApiResponse<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_message?: string;
  last_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

async function main(): Promise<void> {
  const botToken = requireEnv('BOT_TOKEN');
  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}/webhook/telegram`;
  const api = `https://api.telegram.org/bot${botToken}`;

  const setResp = await axios.post<TelegramApiResponse<boolean>>(
    `${api}/setWebhook`,
    { url: webhookUrl, allowed_updates: ALLOWED_UPDATES },
    { timeout: 15_000 }
  );
  console.log('[set-webhook] setWebhook:', webhookUrl, '| ok:', setResp.data.ok, '|', setResp.data.description ?? '');

  const infoResp = await axios.get<TelegramApiResponse<WebhookInfo>>(`${api}/getWebhookInfo`, { timeout: 15_000 });
  console.log('[set-webhook] getWebhookInfo:', JSON.stringify(infoResp.data.result, null, 2));
}

main().catch(err => {
  console.error('[set-webhook] failed:', errText(err));
  process.exit(1);
});
