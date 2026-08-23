import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { auth } from './auth.js';
import { type Env, explorer } from './explorer.js';

const app = new Hono<Env>();

app.use('*', explorer.tracer());
app.use('/api/*', auth);

app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/__explorer', explorer.ui(app, { selfRoutes: false }));

serve({ fetch: app.fetch, port: 3000 });
