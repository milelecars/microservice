import express, { Request, Response } from 'express';
import { verifyChannel } from './handlers/channel';
import { verifyRegistered } from './handlers/registered';
import { verifyDeposited } from './handlers/deposited';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Log every incoming request
app.use((req: Request, _res: Response, next) => {
    console.log(`[request] ${req.method} ${req.path} body:`, JSON.stringify(req.body));
    next();
  });

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});

app.post('/verify/channel', verifyChannel);
app.post('/verify/registered', verifyRegistered);
app.post('/verify/deposited', verifyDeposited);

app.get('/', (_req: Request, res: Response) => {
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