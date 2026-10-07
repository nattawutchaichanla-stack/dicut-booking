# DI-CUT จองคิว + แจ้งเตือน LINE (Vercel + Supabase)

แอพจองคิวร้านตัดผม พร้อมระบบหลังบ้านที่ส่ง LINE แจ้งช่าง และให้ช่างกด **เริ่มตัด / ตัดเสร็จ / ไม่มา / ปล่อยคิว** ในแชต LINE ได้เลย

```
public/index.html   แอพ (ลูกค้า ช่าง เจ้าของร้าน) เปิดจากเว็บนี้แล้วเชื่อมหลังบ้านให้อัตโนมัติ
api/app.mjs         API ของแอพ  (/api/app)
api/line.mjs        LINE webhook (/api/line) ตรวจลายเซ็น LINE ทุกครั้ง
api/tick.mjs        เช็กคิวที่ใกล้ถึง/มาช้า แล้วส่ง LINE (/api/tick?key=CRON_SECRET)
lib/core.mjs        ตรรกะทั้งหมด
lib/db.mjs          ต่อ Supabase (ไม่ต้องติดตั้ง package)
supabase.sql        สร้างตารางใน Supabase (รันครั้งเดียว)
test.mjs            ทดสอบ: node test.mjs && node test_db.mjs
```

## ติดตั้ง (ครั้งเดียว ประมาณ 20 นาที)

### 1) ฐานข้อมูล Supabase (ฟรี)
1. ไปที่ https://supabase.com/dashboard > **New project** · Region: **Southeast Asia (Singapore)**
2. เมนู **SQL Editor** > วางทั้งไฟล์ `supabase.sql` > **Run**
3. **Project Settings > API Keys** คัดลอก `Project URL` และ **secret key** (`sb_secret_…`)

### 2) LINE
1. https://manager.line.biz > บัญชีร้าน > ตั้งค่า > **Messaging API** > เปิดใช้งาน
2. https://developers.line.biz/console/ > channel ของร้าน
   - แท็บ **Basic settings**: คัดลอก `Channel secret`
   - แท็บ **Messaging API**: **Channel access token (long-lived)** > Issue > คัดลอก
3. ใน LINE OA Manager ปิด "ข้อความตอบกลับอัตโนมัติ" (ไม่งั้นบอทจะตอบซ้ำ)

### 3) Vercel
1. https://vercel.com/new > **Import** repo นี้ (หรืออัปโหลดโฟลเดอร์ด้วย `npx vercel deploy --prod`)
   - Framework Preset: **Other** · ไม่ต้องใส่ Build Command
2. **Settings > Environment Variables** เพิ่ม 7 ตัว (Production + Preview)

   | ชื่อ | ค่า |
   |---|---|
   | `SUPABASE_URL` | Project URL จากข้อ 1 |
   | `SUPABASE_KEY` | secret key จากข้อ 1 |
   | `LINE_TOKEN` | Channel access token |
   | `LINE_CHANNEL_SECRET` | Channel secret |
   | `STAFF_KEY` | รหัสเข้าระบบร้าน (ตั้งเองยาว ๆ เช่น `SK-` + ตัวอักษรสุ่ม 16 ตัว) |
   | `APP_SECRET` | ตัวอักษรสุ่มยาว ๆ ใช้เซ็นปุ่มใน LINE |
   | `CRON_SECRET` | ตัวอักษรสุ่ม ใช้เรียก /api/tick |
3. **Settings > Functions > Function Region**: Singapore (sin1) ให้ใกล้ Supabase
4. **Deployments > Redeploy** เพื่อให้ค่าใหม่มีผล
5. เปิด `https://<ชื่อโปรเจกต์>.vercel.app/api/app?a=health` ทุกช่องต้องเป็น `true`

### 4) Webhook + ตัวเช็กคิวทุกนาที
1. LINE Developers > Messaging API > **Webhook URL** = `https://<ชื่อโปรเจกต์>.vercel.app/api/line` > เปิด **Use webhook** > กด **Verify** (ต้องขึ้น Success)
2. แพ็กเกจฟรีของ Vercel ตั้งงานตามเวลาได้วันละครั้ง จึงใช้ https://cron-job.org (ฟรี) แทน:
   สร้างงาน เรียก `https://<ชื่อโปรเจกต์>.vercel.app/api/tick?key=<CRON_SECRET>` **ทุก 1 นาที**
   (แอพที่เปิดค้างในร้านและล็อกอินอยู่ ก็ช่วยเช็กทุกนาทีด้วย)

### 5) เริ่มใช้
1. เปิด `https://<ชื่อโปรเจกต์>.vercel.app` > เข้าสู่ระบบเจ้าของร้าน (เริ่มต้น 0000 เปลี่ยนได้ในแท็บร้าน)
2. แท็บ **ร้าน > แจ้งเตือนช่างทาง LINE** > ใส่ `STAFF_KEY` > **เชื่อมต่อ**
3. ช่างแต่ละคนเพิ่มเพื่อน LINE OA ของร้าน แล้วพิมพ์ **รหัส 6 หลัก** ของตัวเองส่งในแชต
4. กด **ทดสอบส่ง** ข้างชื่อช่าง ต้องได้ข้อความใน LINE
5. ส่งลิงก์เว็บให้ลูกค้าได้เลย มือถือลูกค้าเชื่อมระบบเองอัตโนมัติ ไม่ต้องตั้งค่า

## ค่าใช้จ่าย
- Vercel Hobby, Supabase Free, cron-job.org: ฟรี
- LINE OA ฟรี 300 ข้อความ/เดือน (ข้อความตอบกลับหลังกดปุ่มไม่นับ) ดูประมาณการได้ในแท็บร้าน

## ความปลอดภัย
- webhook รับเฉพาะคำขอที่มีลายเซ็น LINE ถูกต้อง
- ปุ่มใน LINE มีรหัสเซ็นกำกับ และกดได้เฉพาะช่างเจ้าของคิวหรือเจ้าของร้านที่เชื่อม LINE แล้ว
- ลูกค้าเห็นแค่เวลาที่ถูกจอง ไม่เห็นชื่อ/เบอร์ของคนอื่น
- การแก้ไขคิวจากแอพต้องใช้ STAFF_KEY · ฐานข้อมูลกันจองซ้อนเวลาเดียวกันของช่างคนเดียวกัน
- secret key ของ Supabase อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น
