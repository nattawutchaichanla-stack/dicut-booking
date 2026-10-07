import { createCore, httpErr } from './core.mjs';
import { supabaseDb } from './db.mjs';
const missing = { kind: 'none' };
for (const k of ['listBookings', 'bookingsForDate', 'bookingsByPhone', 'getBooking', 'insertBooking', 'updateBooking', 'listStaff', 'upsertStaff', 'claimLinkCode', 'getKv', 'setKv', 'uploadSlip', 'getMember', 'addMember', 'countMembers'])
  missing[k] = async () => { throw httpErr('ยังไม่ได้ตั้งค่าฐานข้อมูล: ใส่ SUPABASE_URL และ SUPABASE_KEY ใน Vercel', 503); };
missing.health = async () => ({ configured: false });
export function coreFromEnv() {
  const env = process.env;
  const db = env.SUPABASE_URL && env.SUPABASE_KEY ? supabaseDb({ url: env.SUPABASE_URL, key: env.SUPABASE_KEY }) : missing;
  return createCore({ db, env });
}
