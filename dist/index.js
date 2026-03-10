"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const channel_1 = require("./handlers/channel");
const registered_1 = require("./handlers/registered");
const deposited_1 = require("./handlers/deposited");
const app = (0, express_1.default)();
app.disable('x-powered-by');
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
// Log every incoming request
app.use((req, _res, next) => {
    console.log(`[request] ${req.method} ${req.path} body:`, JSON.stringify(req.body));
    next();
});
app.get('/health', (_req, res) => {
    res.status(200).send('ok');
});
app.post('/verify/channel', channel_1.verifyChannel);
app.post('/verify/registered', registered_1.verifyRegistered);
app.post('/verify/deposited', deposited_1.verifyDeposited);
app.get('/', (_req, res) => {
    res.status(200).json({
        service: 'kommo-verify',
        routes: ['/health', '/channel', '/registered', '/deposited'],
    });
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
app.listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
});
