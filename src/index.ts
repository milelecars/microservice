import express, { Request, Response } from 'express';
import { verifyChannel } from './handlers/channel';
import { verifyRegistered } from './handlers/registered';
import { verifyDeposited } from './handlers/deposited';
import { handleNewMessage } from './handlers/webhook';
import { handleTelegramWebhook } from './handlers/telegram';
// ...

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, res: Response, next) => {
  const requestId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
  const start = Date.now();

  res.setHeader('x-request-id', requestId);

  const contentType = String(req.headers['content-type'] ?? '');
  const contentLength = String(req.headers['content-length'] ?? '');
  const bodyType = req.body === null ? 'null' : Array.isArray(req.body) ? 'array' : typeof req.body;
  const bodyKeys =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body).slice(0, 30) : [];

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

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});

app.post('/verify/channel', verifyChannel);
app.post('/verify/registered', verifyRegistered);
app.post('/verify/deposited', verifyDeposited);

app.post('/webhook/message', handleNewMessage);
app.post('/webhook/telegram', handleTelegramWebhook);

app.get('/verify/channel', (_req: Request, res: Response) => {
  res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /verify/channel' });
});
app.get('/verify/registered', (_req: Request, res: Response) => {
  res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /verify/registered' });
});
app.get('/verify/deposited', (_req: Request, res: Response) => {
  res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /verify/deposited' });
});

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    service: 'kommo-verify',
    routes: ['/health', '/verify/channel', '/verify/registered', '/verify/deposited'],
  });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'Not Found', path: req.path });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('[http] unhandled error', {
    message: err?.message,
    stack: err?.stack,
  });
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

app.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port}`);
});