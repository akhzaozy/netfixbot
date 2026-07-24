/**
 * index.js
 * ===============================================================
 * Entry point utama WhatsApp Bot dengan Netflix Email Watcher.
 *
 * Menggabungkan dalam SATU PROSES:
 *  - Baileys WhatsApp Bot (koneksi, QR code, kirim/terima pesan)
 *  - Netflix Email Watcher (IMAP IDLE, notifikasi otomatis)
 *
 * Commands yang tersedia:
 *  .home          - Kirim ulang link Netflix terakhir
 *  .netflix       - Info email Netflix terakhir (subject, time, link)
 *  .netflix status - Status koneksi IMAP, sync, RAM usage
 *  .netflix req   - Masuk ke Waiting Room (notif langsung ke pengguna)
 * ===============================================================
 */

import 'dotenv/config';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { mkdir } from 'fs/promises';
import { createLogger } from './modules/logger.js';
import {
  startNetflixWatcher,
  stopNetflixWatcher,
  getWatcherStatus,
  getLastNetflixEmail,
  addToWaitingRoom,
} from './modules/netflixWatcher.js';

const logger = createLogger('Bot');

// Folder untuk menyimpan sesi WhatsApp agar tidak perlu scan QR ulang
const AUTH_DIR = './auth_info';

// ---- State Bot ----
let _sock = null; // Instance Baileys socket

// ====================================================================
// FUNGSI KIRIM PESAN (diteruskan ke Netflix Watcher)
// ====================================================================

/**
 * Mengirim pesan teks ke WhatsApp JID.
 * Ini adalah fungsi yang diteruskan ke netflixWatcher agar dia bisa
 * mengirim notifikasi tanpa perlu tahu detail implementasi Baileys.
 *
 * @param {string} jid - WhatsApp JID tujuan (misal: 628xxx@s.whatsapp.net)
 * @param {string} text - Teks pesan
 */
async function sendMessage(jid, text) {
  if (!_sock) {
    logger.warn('Socket WhatsApp belum siap, pesan tidak terkirim.');
    return;
  }
  await _sock.sendMessage(jid, { text });
}

// ====================================================================
// COMMAND HANDLER
// ====================================================================

/**
 * Menangani perintah yang dikirim pengguna ke bot.
 *
 * @param {string} jid  - JID pengirim
 * @param {string} text - Teks pesan yang diterima
 */
async function handleCommand(jid, text) {
  const trimmed = text.trim().toLowerCase();

  // ---- .home ----
  if (trimmed === '.home') {
    const cache = await getLastNetflixEmail();
    if (!cache.confirmUrl) {
      await sendMessage(jid, '⚠️ Belum ada link Netflix yang tersimpan.');
      return;
    }
    await sendMessage(
      jid,
      `🏠 *Link Netflix Terakhir*\n\n${cache.confirmUrl}`
    );
    return;
  }

  // ---- .netflix req ----
  if (trimmed === '.netflix req') {
    const ttlMinutes = addToWaitingRoom(jid);
    await sendMessage(
      jid,
      `✅ *Waiting Room*\n\n` +
      `Kamu sudah masuk daftar tunggu!\n\n` +
      `Silakan klik tombol *"Kirim Email"* di TV/aplikasi Netflix sekarang.\n\n` +
      `Link konfirmasi akan langsung dikirim ke sini dalam *${ttlMinutes} menit* setelah email masuk.\n\n` +
      `⏰ Waiting list akan otomatis expire dalam ${ttlMinutes} menit.`
    );
    return;
  }

  // ---- .netflix status ----
  if (trimmed === '.netflix status') {
    const status = await getWatcherStatus();
    const connEmoji = status.isConnected ? '🟢' : '🔴';
    const connText = status.isConnected ? 'Connected' : 'Disconnected';
    const lastSync = status.lastSync
      ? new Date(status.lastSync).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : 'Belum pernah';

    await sendMessage(
      jid,
      `📊 *Netflix Watcher Status*\n\n` +
      `${connEmoji} *Status:* ${connText}\n` +
      `🕐 *Last Sync:* ${lastSync} WIB\n` +
      `📧 *Email Diproses:* ${status.emailCount}\n` +
      `💾 *Memory Usage:* ${status.memoryMb} MB`
    );
    return;
  }

  // ---- .netflix ----
  if (trimmed === '.netflix') {
    const cache = await getLastNetflixEmail();
    if (!cache.subject) {
      await sendMessage(jid, '📭 Belum ada email Netflix yang pernah diproses.');
      return;
    }
    const date = cache.date
      ? new Date(cache.date).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB'
      : 'Unknown';

    await sendMessage(
      jid,
      `📺 *Info Netflix Terakhir*\n\n` +
      `📌 *Subject:* ${cache.subject}\n` +
      `🕐 *Time:* ${date}\n` +
      `🔗 *Link:* ${cache.confirmUrl || 'Tidak ada'}\n\n` +
      `Ketik *.home* untuk melihat link saja.\n` +
      `Ketik *.netflix req* untuk masuk waiting room.`
    );
    return;
  }
}

// ====================================================================
// BAILEYS BOT
// ====================================================================

/**
 * Menginisialisasi dan menjalankan Baileys WhatsApp Bot.
 * Akan auto-reconnect jika koneksi terputus.
 */
async function startBot() {
  // Pastikan folder auth ada
  await mkdir(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`Menggunakan Baileys v${version.join('.')}`);

  _sock = makeWASocket({
    version,
    auth: state,
    // Matikan browser fingerprint verbose
    printQRInTerminal: false,
    // Gunakan logger yang minimal untuk hemat resource
    logger: createLogger('Baileys'),
    // Tidak perlu menyimpan semua pesan di memory
    getMessage: async () => undefined,
  });

  // Simpan kredensial setiap kali ada update
  _sock.ev.on('creds.update', saveCreds);

  // ---- Handle koneksi ----
  _sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Tampilkan QR code di terminal jika diminta login
    if (qr) {
      logger.info('Scan QR code di bawah ini dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('WhatsApp Bot terhubung! ✓');

      // Mulai Netflix Watcher setelah WhatsApp terhubung
      // (agar bisa langsung kirim notifikasi jika ada email masuk)
      try {
        await startNetflixWatcher({ sendMessage });
      } catch (err) {
        logger.error(`Gagal memulai Netflix Watcher: ${err.message}`);
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      // Jika logout intentional (scan ulang), jangan reconnect otomatis
      if (reason === DisconnectReason.loggedOut) {
        logger.warn('Bot di-logout. Hapus folder auth_info/ lalu jalankan ulang untuk scan QR baru.');
        process.exit(0);
      }

      logger.warn(`Koneksi terputus (reason: ${reason}). Reconnecting...`);
      // Reconnect
      startBot();
    }
  });

  // ---- Handle pesan masuk ----
  _sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const ownerJid = `${process.env.OWNER_NUMBER}@s.whatsapp.net`;
      const isSelfChat = jid === ownerJid; // owner kirim pesan ke diri sendiri

      // Abaikan pesan fromMe KECUALI owner yang sedang kirim ke chat dirinya sendiri
      // Ini memungkinkan owner test bot dengan kirim command ke "Pesan ke Diri Sendiri"
      if (msg.key.fromMe && !isSelfChat) continue;


      // Ekstrak teks pesan
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text) continue;

      // Hanya proses pesan yang dimulai dengan '.'
      if (!text.trim().startsWith('.')) continue;

      await handleCommand(jid, text).catch((err) =>
        logger.error(`Error saat handle command dari ${jid}: ${err.message}`)
      );
    }
  });
}

// ====================================================================
// GRACEFUL SHUTDOWN
// ====================================================================

async function shutdown(signal) {
  logger.info(`${signal} diterima, mematikan bot dengan bersih...`);
  await stopNetflixWatcher();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Tangkap unhandled rejection agar tidak crash diam-diam
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

// ====================================================================
// MAIN
// ====================================================================

logger.info('=== AutoNetflix WhatsApp Bot ===');
logger.info('Memulai bot...');

startBot().catch((err) => {
  logger.error(`Fatal error saat start: ${err.message}`);
  process.exit(1);
});
