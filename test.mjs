import assert from 'node:assert';
import crypto from 'node:crypto';
import { createCore } from './lib/core.mjs';
import { memoryDb } from './lib/db.mjs';
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ✓ ' + m); };
let clock = Date.parse('2026-10-06T14:00:00+07:00');
const sent = [];
const fetchImpl = async (url, o) => { const p = JSON.parse(o.body); sent.push({ kind: url.endsWith('/push') ? 'push' : 'reply', to: p.to, messages: p.messages }); return { ok: true, status: 200, text: async () => '{}' }; };
const env = { STAFF_KEY: 'SK-TEST', APP_SECRET: 'secret', LINE_TOKEN: 'T', LINE_CHANNEL_SECRET: 'chsec', CRON_SECRET: 'cron' };
const db = memoryDb();
const core = createCore({ db, env, fetchImpl, now: () => clock, log: () => {} });
const KEY = env.STAFF_KEY, get = q => core.appGet(q), post = b => core.appPost(b).catch(e => ({ ok: false, error: e.message }));
const lineEv = ev => core.handleLine([Object.assign({ replyToken: 'RT', source: { type: 'user', userId: ev.uid } }, ev)]);
const last = () => sent[sent.length - 1];

// signature
const raw = JSON.stringify({ events: [] });
ok(core.verifyLine(raw, crypto.createHmac('sha256', 'chsec').update(raw).digest('base64')), 'valid LINE signature accepted');
ok(!core.verifyLine(raw, crypto.createHmac('sha256', 'wrong').update(raw).digest('base64')) && !core.verifyLine(raw, null), 'forged/missing LINE signature rejected');
ok(core.isCron('cron') && !core.isCron('x') && !core.isCron(''), 'tick needs CRON_SECRET');

const cfg = { shopName: 'DI-CUT', lateMin: 15, remindMin: 5, notify: {}, barbers: [{ id: 'b1', name: 'ช่างเอ' }, { id: 'b2', name: 'ช่างบอส' }], services: [{ id: 'cut', name: 'ผู้ใหญ่/เด็ก', min: 30, price: 150 }] };
ok((await post({ a: 'config', key: 'wrong', cfg })).ok === false, 'config rejects wrong key');
let r = await post({ a: 'config', key: KEY, cfg });
ok(r.ok && r.staff.length === 3, 'config creates owner + 2 barbers');
const code = id => r.staff.find(s => s.staffId === id).linkCode;
ok(/^\d{6}$/.test(code('b1')), 'link code is 6 digits');
await lineEv({ type: 'message', uid: 'U_A', message: { type: 'text', text: code('b1') } });
ok(/เชื่อม LINE กับ "ช่างเอ"/.test(last().messages[0].text), 'barber A links with code');
await lineEv({ type: 'message', uid: 'U_B', message: { type: 'text', text: 'รหัส ' + code('b2') } });
await lineEv({ type: 'message', uid: 'U_X', message: { type: 'text', text: code('b1') } });
ok(/ไม่พบรหัส/.test(last().messages[0].text), 'used code cannot be reused');
ok((await post({ a: 'staff', key: KEY })).staff.filter(s => s.linked).length === 2, 'two barbers linked');

sent.length = 0;
const bk = { id: 'BK01', date: '2026-10-06', start: 845, dur: 30, barberId: 'b1', serviceId: 'cut', services: ['cut'], name: 'ต้น', phone: '081-222-3333', status: 'inprogress' };
r = await post({ a: 'create', booking: bk });
ok(r.ok && r.booking.status === 'confirmed', 'public create forces status confirmed');
ok(sent.length === 1 && sent[0].to === 'U_A' && /คิวใหม่/.test(sent[0].messages[0].altText), 'new booking pushed to its barber');
ok((await post({ a: 'create', booking: Object.assign({}, bk, { id: 'BK02' }) })).error === 'slot_taken', 'overlap rejected by database rule');
ok((await post({ a: 'create', booking: Object.assign({}, bk, { id: 'BK02', barberId: 'b2' }) })).ok, 'same time, other barber is fine');
const pub = (await get({ a: 'list' })).bookings.find(b => b.id === 'BK01'), full = (await get({ a: 'list', key: KEY })).bookings.find(b => b.id === 'BK01');
ok(!('phone' in pub) && !('name' in pub) && pub.start === 845, 'public list hides name/phone');
ok(full.phone === bk.phone, 'staff list has full data');

sent.length = 0; await core.tick();
const due = sent.find(m => /ถึงคิว 14:05/.test(m.messages[0].altText));
ok(!!due, 'tick sends due reminder');
const foot = due.messages[0].contents.footer.contents;
ok(foot[0].action.label === 'เริ่มตัด' && foot[1].action.label === 'ลูกค้าไม่มา', 'reminder has เริ่มตัด / ลูกค้าไม่มา');
const startData = foot[0].action.data;
sent.length = 0; await core.tick(); await core.tick();
ok(sent.length === 0, 'reminder never repeated');

sent.length = 0;
await lineEv({ type: 'postback', uid: 'U_A', postback: { data: startData.replace(/t=.*/, 't=AAAAAAAAAAAAAAAA') } });
ok(/หมดอายุหรือไม่ถูกต้อง/.test(last().messages[0].text), 'forged button rejected');
await lineEv({ type: 'postback', uid: 'U_B', postback: { data: startData } });
ok(/เฉพาะช่างเจ้าของคิว/.test(last().messages[0].text), 'other barber cannot press');
await lineEv({ type: 'postback', uid: 'U_STRANGER', postback: { data: startData } });
ok(/ยังไม่ได้เชื่อม/.test(last().messages[0].text), 'unlinked LINE user rejected');
ok((await db.getBooking('BK01')).status === 'confirmed', 'status unchanged after rejected presses');

clock += 6 * 60000; sent.length = 0;
await lineEv({ type: 'postback', uid: 'U_A', postback: { data: startData } });
let b = await db.getBooking('BK01');
ok(b.status === 'inprogress' && b.startedAt === 846 && b.lastAction.via === 'line', 'เริ่มตัด in LINE -> inprogress');
ok(last().kind === 'reply' && last().messages[0].contents.footer.contents[0].action.label === 'ตัดเสร็จ', 'free reply carries ตัดเสร็จ');
const doneData = last().messages[0].contents.footer.contents[0].action.data;
await lineEv({ type: 'postback', uid: 'U_A', postback: { data: startData } });
ok(/กำลังตัดอยู่แล้ว/.test(JSON.stringify(last())), 'double press harmless');

await post({ a: 'create', booking: { id: 'BK03', date: '2026-10-06', start: 900, dur: 30, barberId: 'b1', serviceId: 'cut', name: 'บอล', phone: '0899999999' } });
clock += 24 * 60000; sent.length = 0;
await lineEv({ type: 'postback', uid: 'U_A', postback: { data: doneData } });
b = await db.getBooking('BK01');
ok(b.status === 'done' && b.doneAt === 870, 'ตัดเสร็จ in LINE -> done');
ok(last().messages.length === 2 && /คิวถัดไป 15:00 · บอล/.test(last().messages[1].altText), 'reply shows next queue');

r = await post({ a: 'put', key: KEY, booking: { id: 'BK03', pay: { status: 'paid', amount: 130 } } });
ok(r.ok, 'staff put works');
clock = Date.parse('2026-10-06T15:16:00+07:00'); sent.length = 0; await core.tick();
const lateMsg = sent.find(m => /บอล เลยเวลา 15 นาที/.test(m.messages[0].altText));
ok(!!lateMsg, 'late alert after 15 min');
const rel = lateMsg.messages[0].contents.footer.contents.find(x => x.action.label === 'ปล่อยคิวให้คนอื่น');
await lineEv({ type: 'postback', uid: 'U_A', postback: { data: rel.action.data } });
b = await db.getBooking('BK03');
ok(b.status === 'noshow' && b.released && b.credit === 130, 'release -> noshow + credit');

const stale = await db.getBooking('BK01');
clock += 1000; await post({ a: 'put', key: KEY, booking: { id: 'BK01', note: 'x' } });
r = await post({ a: 'put', key: KEY, booking: { id: 'BK01', status: 'confirmed', _base: stale.updatedAt } });
ok(r.conflict === true && r.booking.status === 'done', 'stale app update refused');

await post({ a: 'create', booking: { id: 'BK04', date: '2026-10-07', start: 600, dur: 30, barberId: 'b2', serviceId: 'cut', name: 'นิว', phone: '0811111111' } });
ok((await post({ a: 'cancel', id: 'BK04', phone: '0800000000' })).ok === false, 'cancel needs matching phone');
ok((await post({ a: 'cancel', id: 'BK04', phone: '081-111-1111' })).booking.status === 'cancelled', 'customer cancel works');
ok((await post({ a: 'create', booking: { id: 'BK04b', date: '2026-10-07', start: 600, dur: 30, barberId: 'b2', serviceId: 'cut', name: 'ใหม่', phone: '0822' } })).ok, 'cancelled slot can be rebooked');
ok((await post({ a: 'mine', phone: '081-111-1111' })).bookings.length === 1, 'mine lookup by phone');

await post({ a: 'create', booking: { id: 'BK05', date: '2026-10-06', start: 960, dur: 30, barberId: 'b1', serviceId: 'cut', name: 'เจ', phone: '0822222222' } });
sent.length = 0; await lineEv({ type: 'message', uid: 'U_A', message: { type: 'text', text: 'คิว' } });
ok(/คิววันนี้ 1 คิว/.test(last().messages[0].altText), '"คิว" command');

const ownerCode = (await post({ a: 'staff', key: KEY })).staff.find(s => s.role === 'owner').linkCode;
await lineEv({ type: 'message', uid: 'U_OWN', message: { type: 'text', text: ownerCode } });
sent.length = 0;
await post({ a: 'create', booking: { id: 'BK06', date: '2026-10-06', start: 1020, dur: 30, barberId: 'b2', serviceId: 'cut', name: 'โอ๊ต', phone: '0833333333', pay: { status: 'paid', amount: 130, slip: 'data:image/jpeg;base64,' + Buffer.from('img').toString('base64') } } });
const slipMsg = sent.find(m => m.to === 'U_OWN');
ok(slipMsg && /สลิปใหม่/.test(slipMsg.messages[0].altText), 'slip notification to owner');
const stored = await db.getBooking('BK06');
ok(stored.pay.status === 'review' && /\/storage\/v1\/object\/public\/slips\/BK06-.+\.jpg$/.test(stored.pay.slip), 'public cannot self-mark paid; slip moved to storage');
const paid = slipMsg.messages[0].contents.footer.contents.find(x => x.action.type === 'postback');
await lineEv({ type: 'postback', uid: 'U_B', postback: { data: paid.action.data } });
ok(/เฉพาะเจ้าของร้าน/.test(last().messages[0].text), 'barber cannot confirm slip');
await lineEv({ type: 'postback', uid: 'U_OWN', postback: { data: paid.action.data } });
ok((await db.getBooking('BK06')).pay.status === 'paid', 'owner confirms slip in LINE');

const all = []; const walk = o => { if (o && typeof o === 'object') { if (o.type === 'postback') all.push(o); Object.values(o).forEach(walk); } };
sent.forEach(walk);
ok(all.length > 0 && all.every(a => Array.from(a.label).length <= 20 && a.data.length <= 300), 'button labels ≤20 chars, data ≤300');
ok((await get({ a: 'tick', key: 'nope' }).catch(e => e.status)) === 401, 'app tick needs staff key');
const h = await get({ a: 'health' });
ok(h.ok && h.line.token && !JSON.stringify(h).includes('SK-TEST'), 'health reports setup without leaking secrets');
r = await post({ a: 'appcfg', key: KEY, cfg: { shopName: 'X', ownerPin: '9999', line: { key: 'SK' }, barbers: [{ id: 'b1', name: 'เอ', pin: '1111' }], services: [{ id: 'cut', price: 160 }] } });
ok(r.ok, 'owner saves shop settings');
ok((await post({ a: 'appcfg', key: 'bad', cfg: {} })).ok === false, 'only staff can save shop settings');
const ac = (await get({ a: 'appcfg' })).app;
ok(ac.cfg.services[0].price === 160 && !JSON.stringify(ac).includes('9999') && !JSON.stringify(ac).includes('1111') && !ac.cfg.line, 'phones get settings without PINs/keys');
console.log('\nALL ' + pass + ' CHECKS PASSED');

// members
{
  const m0 = await get({ a: 'members' });
  ok(m0.ok && typeof m0.count === 'number', 'members count available');
  let j = await post({ a: 'join', name: 'โจ้', phone: '0861112222' });
  ok(j.ok && j.count === m0.count + 1 && !j.back, 'new member joins and count goes up');
  j = await post({ a: 'join', name: 'คนอื่น', phone: '086-111-2222' });
  ok(!j.ok && j.error === 'phone_taken', 'same phone with a different nickname is refused');
  j = await post({ a: 'join', name: 'พี่โจ้', phone: '0861112222' });
  ok(j.ok && j.back && j.count === m0.count + 1, 'same phone + same nickname (ignoring พี่) is a returning member');
  j = await post({ a: 'join', name: 'โจ้ใหม่', phone: '0861112222', oldPhone: '0861112222' });
  ok(j.ok && (await db.getMember('0861112222')).name === 'โจ้ใหม่', 'member can rename their own number');
  ok((await post({ a: 'join', name: '', phone: '0861112222' })).ok === false, 'join needs a nickname');
  const before = (await get({ a: 'members' })).count;
  await post({ a: 'create', booking: { id: 'MEM1', date: '2026-10-08', start: 700, dur: 30, barberId: 'b2', serviceId: 'cut', services: ['cut'], name: 'บอย', phone: '0870009999' } });
  ok((await get({ a: 'members' })).count === before + 1, 'booking with a new phone adds a member');
  const t = await get({ a: 'members' });
  ok(t.today >= 2, 'members joined today are counted');
}
// staff login by PIN
{
  await post({ a: 'appcfg', key: KEY, cfg: { shopName: 'DI-CUT', ownerPin: '9999', barbers: [{ id: 'b1', name: 'ช่างเอ', pin: '4321' }, { id: 'b2', name: 'ช่างบอส' }] } });
  const st = await db.getKv('appcfg'); ok(!st.cfg.ownerPin && !st.cfg.barbers[0].pin, 'PINs are not stored in public app settings');
  ok(!JSON.stringify(await db.getKv('pins')).includes('4321'), 'PINs stored only as hashes');
  let r = await post({ a: 'login', who: 'b1', pin: '4321' }); ok(r.ok && r.key === KEY && r.role === 'barber', 'barber logs in with PIN and gets the shop key');
  ok((await post({ a: 'login', who: 'b2', pin: '1234' })).ok, 'barber without custom PIN uses default');
  ok((await post({ a: 'login', who: 'owner', pin: '9999' })).role === 'owner', 'owner logs in with PIN');
  ok((await post({ a: 'login', who: 'b1', pin: '0000' })).error === 'bad_pin', 'wrong PIN refused');
  for (let i = 0; i < 8; i++) await post({ a: 'login', who: 'b2', pin: '000' + i });
  ok((await post({ a: 'login', who: 'b2', pin: '1234' })).error === 'locked', 'too many wrong PINs locks for 15 minutes');
  clock += 16 * 60e3; ok((await post({ a: 'login', who: 'b2', pin: '1234' })).ok, 'lock expires');
}
// in-app chat
{
  const id = 'CHATtest_abcdefgh123';
  const before = sent.length;
  let r = await post({ a: 'chat_send', id, name: 'โจ้', phone: '086-111-2222', text: 'จองยังไงครับ' });
  ok(r.ok && r.thread.msgs.length === 1 && r.thread.msgs[0].f === 'c', 'customer sends a chat message');
  ok((await post({ a: 'chat_list', key: 'bad' })).ok === false, 'chat list needs the shop key');
  r = await post({ a: 'chat_list', key: KEY }); ok(r.ok && r.unread === 1 && r.threads[0].id === id && r.threads[0].phone === '0861112222', 'staff sees the thread with unread count and phone');
  r = await post({ a: 'chat_read', key: KEY, id }); ok(r.ok && r.thread.msgs.length === 1, 'staff opens thread');
  ok((await post({ a: 'chat_list', key: KEY })).unread === 0, 'opening clears unread');
  r = await post({ a: 'chat_reply', key: KEY, id, text: 'กดปุ่ม + ด้านล่างได้เลยครับ', by: 'เจ้าของร้าน' }); ok(r.ok, 'staff replies');
  r = await post({ a: 'chat_get', id }); ok(r.thread.msgs.length === 2 && r.thread.msgs[1].f === 's' && r.thread.unread === 1, 'customer sees reply as unread');
  ok(!r.thread.msgs[1].by || r.thread.msgs[1].by === 'ร้าน', 'staff name not exposed to customer');
  r = await post({ a: 'chat_get', id, seen: 1 }); ok((await post({ a: 'chat_get', id })).thread.unread === 0, 'customer marks seen');
  ok((await post({ a: 'chat_get', id: 'short' })).ok === false, 'chat id must be long and random');
  ok((await post({ a: 'chat_send', id, text: '   ' })).ok === false, 'empty message refused');
  for (let k = 0; k < 29; k++) await post({ a: 'chat_send', id, name: 'โจ้', text: 'm' + k });
  ok((await post({ a: 'chat_send', id, name: 'โจ้', text: 'spam' })).error === 'too_many', 'spam limit 30 messages per hour');
}
// shop graphics mirrored to all phones
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  ok((await post({ a: 'gfx_put', key: 'bad', k: 'icLine', v: png })).ok === false, 'graphics upload needs the shop key');
  ok((await post({ a: 'gfx_put', key: KEY, k: 'icLine', v: 'data:text/html;base64,PHNjcmlwdD4=' })).ok === false, 'only png/jpeg/webp images accepted');
  let r = await post({ a: 'gfx_put', key: KEY, k: 'icLine', v: png }); ok(r.ok && r.at, 'owner uploads an icon');
  r = await get({ a: 'gfx_idx' }); ok(r.idx.icLine === clock, 'index lists the icon for every phone');
  ok((await get({ a: 'gfx_get', k: 'icLine' })).v === png, 'any phone downloads the icon');
  await post({ a: 'gfx_put', key: KEY, k: 'icLine', v: null });
  ok(!(await get({ a: 'gfx_idx' })).idx.icLine && (await get({ a: 'gfx_get', k: 'icLine' })).v === null, 'removing the icon removes it everywhere');
}
console.log('\n' + pass + ' checks passed');
