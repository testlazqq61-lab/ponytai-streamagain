# Ponytai StreamAgain

เว็บแอพสำหรับรีรันวิดีโอไปยัง stream key หลายปลายทาง โดยหน้าเว็บสามารถ deploy บน Cloudflare Pages ได้ และให้เครื่องของคุณรัน local agent เพื่อเลือกวิดีโอจากเครื่องกับยิง FFmpeg ออกไปยัง RTMP/stream key

## ทำงานยังไง

- Cloudflare Pages: โฮสต์หน้าเว็บ control panel
- เครื่องคุณ: รัน local agent ที่ `http://localhost:8787`
- FFmpeg: อ่านไฟล์วิดีโอจากโฟลเดอร์ในเครื่อง แล้วส่งไป YouTube, Facebook, Twitch, TikTok หรือ RTMP custom

Cloudflare Pages/Workers ไม่สามารถอ่านไฟล์วิดีโอในคอมคุณโดยตรงและไม่เหมาะกับการรัน FFmpeg ตลอดเวลา ดังนั้นงานสตรีมจริงต้องรันบนเครื่องคุณหรือ VPS ภายหลัง

## เริ่มใช้งานบนเครื่อง

1. ติดตั้ง Node.js และ FFmpeg
2. ตั้งค่า `.env` จาก `.env.example`
3. วางวิดีโอไว้ในโฟลเดอร์ที่ตั้งใน `VIDEO_ROOT` หรืออัพโหลดผ่านหน้า `Videos`
4. รัน:

```powershell
npm.cmd run start
```

แล้วเปิดเว็บที่:

```text
http://localhost:5173
```

## Deploy หน้าเว็บบน Cloudflare Pages

อัพโหลดโฟลเดอร์นี้ขึ้น GitHub แล้วเชื่อม Cloudflare Pages

- Build command: เว้นว่าง
- Build output directory: `web`

เวลาเปิดเว็บจาก Cloudflare ให้เปิด local agent บนเครื่องคุณไว้ด้วย:

```powershell
npm.cmd run agent
```

จากนั้นเปิด:

```text
https://ponytai-streamagain.pages.dev
```

ถ้าหน้าเว็บขึ้น `Agent offline` ให้กด refresh หลังจากเปิด local agent แล้ว

## หมายเหตุเรื่องความปลอดภัย

- Stream key จะถูกส่งไปที่ local agent บนเครื่องคุณเท่านั้น
- อย่าแชร์หน้าจอหรือไฟล์ `.env` ที่มี key
- local agent อนุญาตให้อ่านเฉพาะไฟล์ใน `VIDEO_ROOT`

## ขีดจำกัด

จำนวนช่องไม่ล็อกในแอพ แต่จะจำกัดตาม CPU/GPU, ความเร็วเน็ตอัพโหลด, bitrate และจำนวน FFmpeg process ที่เครื่องรับไหว
