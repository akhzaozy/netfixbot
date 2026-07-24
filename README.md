# 📺 AutoNetflix WhatsApp Bot

WhatsApp Bot berbasis **Node.js + Baileys** yang memantau email Gmail Anda secara _real-time_ menggunakan **IMAP IDLE** dan mengirimkan notifikasi link konfirmasi Netflix langsung ke WhatsApp.

> **No polling. CPU ~0% saat idle. Cocok untuk server Ubuntu dengan RAM rendah.**

---

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| 📬 IMAP IDLE | Real-time, tanpa polling |
| 🔔 Notifikasi otomatis | Link konfirmasi Netflix langsung ke WA |
| 👥 Waiting Room | Pengguna bisa request notif langsung ke nomor mereka |
| 🔄 Auto-reconnect | Exponential backoff, tidak crash |
| 🗄️ Cache JSON | Tidak ada notif ganda |
| 🧩 Arsitektur modular | Mudah tambah provider baru (Steam, GitHub, dll) |
| 💾 Hemat memory | HTML tidak disimpan di RAM |

---

## 📋 Persyaratan

- Node.js >= 20
- Ubuntu Server (atau OS Linux/Windows apapun)
- Akun Gmail dengan 2FA aktif
- App Password Gmail

---

## 🗂️ Struktur Folder

```
autonetflix/
├── index.js                          # Entry point utama
├── package.json
├── .env                              # Kredensial (jangan di-commit!)
├── .env.example                      # Template .env
├── .gitignore
├── cache.json                        # Dibuat otomatis saat bot jalan
├── auth_info/                        # Dibuat otomatis (sesi WhatsApp)
└── modules/
    ├── logger.js                     # Logger terpusat
    ├── netflixWatcher.js             # Facade utama
    ├── db/
    │   └── CacheHelper.js            # Penyimpanan state JSON
    └── email/
        ├── EmailClient.js            # Klien IMAP + IDLE
        └── providers/
            └── NetflixProvider.js    # Parser email Netflix
```

---

## 🚀 Cara Instalasi

### 1. Clone / Salin Project

```bash
git clone <repo-url> autonetflix
cd autonetflix
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Setup Gmail App Password

> ⚠️ Anda **WAJIB** menggunakan App Password, bukan password Gmail biasa.

**Langkah-langkah:**
1. Buka [myaccount.google.com](https://myaccount.google.com)
2. Pilih **Security** → **2-Step Verification** (aktifkan jika belum)
3. Scroll ke bawah, klik **App Passwords**
4. Pilih **App: Mail**, **Device: Other** → tulis "AutoNetflix"
5. Google akan memberikan kode **16 karakter** (contoh: `abcd efgh ijkl mnop`)
6. Salin kode tersebut - ini yang akan diisi di `EMAIL_PASS`

### 4. Buat File `.env`

```bash
cp .env.example .env
nano .env
```

Isi file `.env`:

```env
EMAIL_HOST=imap.gmail.com
EMAIL_PORT=993
EMAIL_USER=emailanda@gmail.com
EMAIL_PASS=abcd efgh ijkl mnop
OWNER_NUMBER=628123456789
WAITING_ROOM_TTL_MINUTES=5
```

### 5. Jalankan Bot

```bash
npm start
```

Bot akan menampilkan **QR Code** di terminal. Scan dengan WhatsApp Anda.

---

## 📱 Daftar Command WhatsApp

| Command | Fungsi |
|---|---|
| `.home` | Kirim ulang link konfirmasi Netflix terakhir |
| `.netflix` | Tampilkan info email terakhir (subject, waktu, link) |
| `.netflix status` | Status IMAP, last sync, jumlah email, penggunaan RAM |
| `.netflix req` | Masuk Waiting Room - notif langsung ke nomor Anda |

---

## 🏠 Fitur "Sistem Gacor" - Waiting Room

```
Pengguna A: .netflix req
Bot:        ✅ Kamu masuk waiting room! Silakan klik "Kirim Email" di Netflix.

[Pengguna A klik tombol di TV Netflix]
[Email konfirmasi masuk ke Gmail ~30 detik kemudian]

Bot → Pengguna A: 📺 Netflix Alert - Link: https://...
Bot → Owner:      📺 Netflix Alert - Link: https://...
```

---

## 🔧 Menambah Provider Email Baru

Buat file `modules/email/providers/SteamProvider.js`:

```js
export function matches(from, subject) {
  return from.toLowerCase().includes('steampowered.com');
}

export function parse(parsedMail) {
  return {
    messageId: parsedMail.messageId,
    subject: parsedMail.subject,
    from: parsedMail.from?.text,
    date: parsedMail.date?.toISOString(),
    confirmUrl: null,
    rawText: parsedMail.text?.slice(0, 500),
  };
}
```

Lalu daftarkan di `modules/netflixWatcher.js`:

```js
import * as SteamProvider from './email/providers/SteamProvider.js';

const providers = [
  { name: 'netflix', ...NetflixProvider },
  { name: 'steam',   ...SteamProvider },  // tambahkan ini
];
```

---

## 🖥️ Menjalankan sebagai Systemd Service (Ubuntu)

```bash
sudo nano /etc/systemd/system/autonetflix.service
```

```ini
[Unit]
Description=AutoNetflix WhatsApp Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/autonetflix
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable autonetflix
sudo systemctl start autonetflix
sudo journalctl -u autonetflix -f
```

---

## 📦 Dependencies

| Package | Fungsi |
|---|---|
| `@whiskeysockets/baileys` | WhatsApp Web API |
| `imapflow` | IMAP client dengan IDLE support |
| `mailparser` | Parse email RFC 2822 |
| `dotenv` | Load .env variables |
| `pino` + `pino-pretty` | Logging |
| `qrcode-terminal` | QR code di terminal |

---

## 🔒 Keamanan

- ✅ Password Gmail tidak pernah ada di source code
- ✅ Semua credential dari `.env`
- ✅ `.env` dan `auth_info/` di-exclude dari git
- ✅ Bot tidak pernah mengklik atau mengakses URL konfirmasi
- ✅ Bot hanya mengirim notifikasi dan menyimpan link
