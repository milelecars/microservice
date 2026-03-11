"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const channel_1 = require("./handlers/channel");
const registered_1 = require("./handlers/registered");
const deposited_1 = require("./handlers/deposited");
const webhook_1 = require("./handlers/webhook");
const telegram_1 = require("./handlers/telegram");
const stage_1 = require("./handlers/stage");
const app = (0, express_1.default)();
app.disable('x-powered-by');
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.post('/webhook/stage', stage_1.handleStageChange);
app.use((req, res, next) => {
    const requestId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
    const start = Date.now();
    res.setHeader('x-request-id', requestId);
    const contentType = String(req.headers['content-type'] ?? '');
    const contentLength = String(req.headers['content-length'] ?? '');
    const bodyType = req.body === null ? 'null' : Array.isArray(req.body) ? 'array' : typeof req.body;
    const bodyKeys = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body).slice(0, 30) : [];
    console.log('[http] request', {
        requestId,
        method: req.method,
        path: req.path,
        contentType,
        contentLength,
        bodyType,
        bodyKeys,
    });
    res.on('finish', () => {
        console.log('[http] response', {
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - start,
        });
    });
    next();
});
app.get('/health', (_req, res) => {
    res.status(200).send('ok');
});
app.post('/verify/channel', channel_1.verifyChannel);
app.post('/verify/registered', registered_1.verifyRegistered);
app.post('/verify/deposited', deposited_1.verifyDeposited);
app.post('/webhook/message', webhook_1.handleNewMessage);
app.post('/webhook/telegram', telegram_1.handleTelegramWebhook);
app.get('/verify/channel', (_req, res) => {
    res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /verify/channel' });
});
app.get('/verify/registered', (_req, res) => {
    res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /verify/registered' });
});
app.get('/verify/deposited', (_req, res) => {
    res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /verify/deposited' });
});
app.get('/', (_req, res) => {
    res.status(200).json({
        service: 'kommo-verify',
        routes: ['/health', '/verify/channel', '/verify/registered', '/verify/deposited'],
    });
});
app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not Found', path: req.path });
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[http] unhandled error', {
        message: err?.message,
        stack: err?.stack,
    });
    if (res.headersSent)
        return;
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
app.listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
});
