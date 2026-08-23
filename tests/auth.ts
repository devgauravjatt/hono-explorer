import type { MiddlewareHandler } from 'hono';
import type { Env } from './explorer.js';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const auth: MiddlewareHandler<Env> = async function auth(c, next) {
  const key = c.req.header('x-api-key');

  c.var.trace.data.key = key;

  await c.var.trace.span('outer', async () => {
    await c.var.trace.span('inner-1', () => sleep(20));
    await c.var.trace.span('inner-2', () => sleep(10));
  });

  const session = await c.var.trace.span('db:session', async () => {
    // wait 2s to simulate a slow db call
    await new Promise((r) => setTimeout(r, 2000));
    return key ? { userId: `u_${key}` } : null;
  });

  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', session.userId);
  await next();
};
