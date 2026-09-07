"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../env");
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'chat_member'];
async function main() {
    const botToken = (0, env_1.requireEnv)('BOT_TOKEN');
    const publicUrl = (0, env_1.requireEnv)('PUBLIC_URL').replace(/\/+$/, '');
    const webhookUrl = `${publicUrl}/webhook/telegram`;
    const api = `https://api.telegram.org/bot${botToken}`;
    const setResp = await axios_1.default.post(`${api}/setWebhook`, { url: webhookUrl, allowed_updates: ALLOWED_UPDATES }, { timeout: 15000 });
    console.log('[set-webhook] setWebhook:', webhookUrl, '| ok:', setResp.data.ok, '|', setResp.data.description ?? '');
    const infoResp = await axios_1.default.get(`${api}/getWebhookInfo`, { timeout: 15000 });
    console.log('[set-webhook] getWebhookInfo:', JSON.stringify(infoResp.data.result, null, 2));
}
main().catch(err => {
    console.error('[set-webhook] failed:', (0, env_1.errText)(err));
    process.exit(1);
});
