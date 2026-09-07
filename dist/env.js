"use strict";
// Central environment access. Nothing else in the service should read
// process.env for a secret directly, so redaction stays in one place.
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireEnv = requireEnv;
exports.assertEnv = assertEnv;
exports.redact = redact;
exports.errText = errText;
const REQUIRED_ENV = [
    'KOMMO_TOKEN',
    'KOMMO_TG_WEBHOOK',
    'BOT_TOKEN',
    'CHANNEL_ID',
    'SUPABASE_URL',
    'SUPABASE_KEY',
];
/** Read an env var, throwing if it is missing or empty. */
function requireEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing required environment variable: ${name}`);
    return value;
}
/** Fail loudly at startup when anything the service needs is not configured. */
function assertEnv() {
    const missing = REQUIRED_ENV.filter(name => !process.env[name]);
    if (missing.length > 0) {
        console.error('[env] missing required environment variables:', missing.join(', '));
        process.exit(1);
    }
    console.log('[env] all required environment variables present');
}
/**
 * Strip secrets out of anything we are about to log. Covers the literal
 * values of the configured tokens plus Telegram-style bot tokens and the
 * `?t=<bot token>` query param on the Kommo Telegram hook URL.
 */
function redact(value) {
    let out = value;
    for (const secret of [process.env.BOT_TOKEN, process.env.KOMMO_TOKEN, process.env.SUPABASE_KEY]) {
        if (secret && secret.length > 8)
            out = out.split(secret).join('***');
    }
    return out
        .replace(/([?&](?:t|token|api_?key|apikey|key)=)[^&\s]+/gi, '$1***')
        .replace(/(\d{5,}):[A-Za-z0-9_-]{10,}/g, '$1:***');
}
/** Safe one-line description of an error for logs. */
function errText(err) {
    if (err && typeof err === 'object') {
        const e = err;
        const data = e.response?.data;
        if (data !== undefined)
            return redact(typeof data === 'string' ? data : JSON.stringify(data));
        if (e.message)
            return redact(e.message);
    }
    return redact(String(err));
}
