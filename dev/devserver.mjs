import http from 'node:http'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { createCore, json, guard } from '../lib/core.mjs'; import { memoryDb } from '../lib/db.mjs';
const env = { STAFF_KEY: 'SK-LOCAL', APP_SECRET: 'as', LINE_TOKEN: 'T', LINE_CHANNEL_SECRET: 'cs', CRON_SECRET: 'cr' };
const sent = []; const db = memoryDb();
const core = createCore({ db, env, log: () => {}, fetchImpl: async (u, o) => { sent.push({ kind: u.endsWith('/push') ? 'push' : 'reply', ...JSON.parse(o.body) }); return { ok: true, status: 200, text: async () => '{}' }; } });
const toNode = async (res, r) => { res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); };
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/app') return toNode(res, req.method === 'GET' ? await guard(() => core.appGet(Object.fromEntries(u.searchParams))) : await guard(() => core.appPost(JSON.parse(body || '{}'))));
  if (u.pathname === '/api/line') { if (!core.verifyLine(body, req.headers['x-line-signature'])) return toNode(res, json({ ok: false }, 401)); await core.handleLine(JSON.parse(body).events); return toNode(res, json({ ok: true })); }
  if (u.pathname === '/api/tick') return toNode(res, core.isCron(u.searchParams.get('key')) ? await guard(() => core.tick()) : json({ ok: false }, 401));
  if (u.pathname === '/debug') return toNode(res, json({ sent, staff: await db.listStaff() }));
  if (u.pathname === '/sign') return toNode(res, json({ sig: crypto.createHmac('sha256', 'cs').update(body).digest('base64') }));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(new URL('../public/index.html', import.meta.url)));
}).listen(8788, () => console.log('dev on 8788'));
