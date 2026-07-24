/**
 * netflixWatcher.js
 * ===============================================================
 * Modul utama Netflix Email Watcher.
 *
 * Ini adalah "fasad" (facade) yang menyatukan:
 *  - EmailClient (koneksi IMAP)
 *  - NetflixProvider (parser email)
 *  - CacheHelper (penyimpanan state)
 *
 * Modul ini bertugas:
 *  1. Menginisialisasi dan mengelola EmailClient
 *  2. Menerima event 'newEmail' dan memprosesnya
 *  3. Memanggil callback untuk mengirim notifikasi WhatsApp
 *  4. Mengelola Waiting Room (daftar pengguna yang menunggu email)
 *  5. Menyediakan data untuk command .home, .netflix, .netflix status
 *
 * Cara penggunaan di index.js:
 *   import { startNetflixWatcher } from './modules/netflixWatcher.js';
 *   await startNetflixWatcher({ sendMessage, config });
 * ===============================================================
 */

import 'dotenv/config';
import { EmailClient } from './email/EmailClient.js';
import * as NetflixProvider from './email/providers/NetflixProvider.js';
import {
  readCache,
  isAlreadyProcessed,
  markAsProcessed,
  updateSyncTime,
} from './db/CacheHelper.js';
import { createLogger } from './logger.js';

const logger = createLogger('NetflixWatcher');

// ---- Konfigurasi dari Environment Variables ----
const IMAP_CONFIG = {
  host: process.env.EMAIL_HOST || 'imap.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '993', 10),
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS,
};

const OWNER_NUMBER = process.env.OWNER_NUMBER;
const WAITING_ROOM_TTL_MS =
  parseInt(process.env.WAITING_ROOM_TTL_MINUTES || '5', 10) * 60 * 1000;

// ---- State Internal ----
let _emailClient = null;

/**
 * Waiting Room: Map dari JID pengguna -> timestamp expiry.
 * Pengguna yang ada di sini akan menerima notifikasi langsung
 * saat email Netflix masuk (fitur "Sistem Gacor").
 * @type {Map<string, number>}
 */
const _waitingRoom = new Map();

// ---- Public API ----

/**
 * Memulai Netflix Email Watcher.
 * Dipanggil sekali dari index.js saat bot menyala.
 *
 * @param {object} options
 * @param {function(string, string): Promise<void>} options.sendMessage
 *   Fungsi untuk mengirim WhatsApp message. Menerima (jid, text).
 * @returns {Promise<void>}
 */
async function startNetflixWatcher({ sendMessage }) {
  _validateConfig();

  // Daftarkan semua provider email yang akan dipantau.
  // Untuk menambah provider baru, cukup tambahkan ke array ini.
  const providers = [
    { name: 'netflix', matches: NetflixProvider.matches, parse: NetflixProvider.parse },
    // Contoh: { name: 'steam', matches: SteamProvider.matches, parse: SteamProvider.parse },
    // Contoh: { name: 'github', matches: GithubProvider.matches, parse: GithubProvider.parse },
  ];

  _emailClient = new EmailClient({
    ...IMAP_CONFIG,
    providers,
  });

  // Event: koneksi berhasil
  _emailClient.on('connected', async () => {
    logger.info('Connected');
    await updateSyncTime();
  });

  // Event: koneksi terputus
  _emailClient.on('disconnected', () => {
    logger.warn('Disconnected');
  });

  // Event: email baru yang relevan diterima
  _emailClient.on('newEmail', async ({ provider, data }) => {
    logger.info(`New email detected dari provider: ${provider}`);
    await _handleNewEmail({ provider, data, sendMessage });
  });

  logger.info('Starting...');
  await _emailClient.start();
}

/**
 * Menghentikan watcher dengan bersih. Dipanggil saat proses Node.js akan berhenti.
 */
async function stopNetflixWatcher() {
  if (_emailClient) {
    await _emailClient.stop();
    _emailClient = null;
  }
}

/**
 * Mendapatkan status watcher untuk command .netflix status
 * @returns {Promise<object>}
 */
async function getWatcherStatus() {
  const cache = await readCache();
  const memUsage = process.memoryUsage();
  const memMb = (memUsage.rss / 1024 / 1024).toFixed(1);

  return {
    isConnected: _emailClient?.getStatus().isConnected ?? false,
    lastSync: cache.syncedAt,
    emailCount: cache.emailCount,
    memoryMb: memMb,
  };
}

/**
 * Mendapatkan data email Netflix terakhir untuk command .netflix
 * @returns {Promise<object>}
 */
async function getLastNetflixEmail() {
  return readCache();
}

/**
 * Menambahkan pengguna ke Waiting Room.
 * Pengguna akan menerima notifikasi langsung saat email Netflix masuk.
 * Entry akan expire setelah WAITING_ROOM_TTL_MS.
 *
 * @param {string} jid - WhatsApp JID pengguna
 * @returns {number} Menit TTL
 */
function addToWaitingRoom(jid) {
  const expiry = Date.now() + WAITING_ROOM_TTL_MS;
  _waitingRoom.set(jid, expiry);
  const ttlMinutes = WAITING_ROOM_TTL_MS / 60000;
  logger.info(`${jid} ditambahkan ke waiting room (TTL: ${ttlMinutes} menit)`);
  return ttlMinutes;
}

/**
 * Mengecek apakah pengguna ada di Waiting Room (dan belum expire).
 * @param {string} jid
 * @returns {boolean}
 */
function isInWaitingRoom(jid) {
  const expiry = _waitingRoom.get(jid);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    _waitingRoom.delete(jid);
    return false;
  }
  return true;
}

// ---- Private Helpers ----

/**
 * Memproses email baru yang sudah diterima dari EmailClient.
 * Mengirim notifikasi ke Owner dan ke pengguna di Waiting Room.
 */
async function _handleNewEmail({ provider, data, sendMessage }) {
  // Cek apakah email ini sudah pernah diproses sebelumnya
  const alreadyDone = await isAlreadyProcessed(data.messageId);
  if (alreadyDone) {
    logger.info(`Email ${data.messageId} sudah pernah diproses, skip.`);
    return;
  }

  // Simpan ke cache
  await markAsProcessed(data);
  logger.info('Notification sent');

  // Format pesan WhatsApp
  const message = _formatWhatsAppMessage(data);

  // Kirim ke Owner
  if (OWNER_NUMBER) {
    const ownerJid = `${OWNER_NUMBER}@s.whatsapp.net`;
    await sendMessage(ownerJid, message).catch((err) =>
      logger.error(`Gagal kirim ke owner: ${err.message}`)
    );
  }

  // Kirim ke semua pengguna di Waiting Room (fitur "Sistem Gacor")
  const waitingUsers = _getActiveWaitingUsers();
  for (const jid of waitingUsers) {
    if (jid !== `${OWNER_NUMBER}@s.whatsapp.net`) {
      const userMessage = `📺 *Netflix Alert* - Notifikasi untuk Anda!\n\n${message}`;
      await sendMessage(jid, userMessage).catch((err) =>
        logger.error(`Gagal kirim ke ${jid}: ${err.message}`)
      );
    }
    _waitingRoom.delete(jid); // Hapus dari waiting room setelah dikirim
  }
}

/**
 * Mendapatkan daftar JID pengguna yang aktif di Waiting Room (belum expire).
 * @returns {string[]}
 */
function _getActiveWaitingUsers() {
  const now = Date.now();
  const active = [];
  for (const [jid, expiry] of _waitingRoom.entries()) {
    if (now <= expiry) {
      active.push(jid);
    } else {
      _waitingRoom.delete(jid);
    }
  }
  return active;
}

/**
 * Memformat data email menjadi pesan WhatsApp yang rapi.
 * @param {object} data - Data email dari provider.parse()
 * @returns {string}
 */
function _formatWhatsAppMessage(data) {
  const date = data.date ? _formatDate(new Date(data.date)) : 'Unknown';
  const linkLine = data.confirmUrl
    ? `🔗 *Confirmation Link:*\n${data.confirmUrl}`
    : '⚠️ Tidak ada link konfirmasi yang ditemukan di email ini.';

  return (
    `📺 *Netflix Alert*\n\n` +
    `📌 *Subject:*\n${data.subject}\n\n` +
    `🕐 *Time:*\n${date}\n\n` +
    `📧 *Sender:*\n${data.from}\n\n` +
    `${linkLine}\n\n` +
    `---\n` +
    `Reply *_.home_* untuk melihat link ini lagi.\n` +
    `Reply *_.netflix_* untuk info lengkap.`
  );
}

/**
 * Memformat tanggal ke format lokal yang mudah dibaca.
 * @param {Date} date
 * @returns {string}
 */
function _formatDate(date) {
  return date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' WIB';
}

/**
 * Validasi konfigurasi yang wajib ada di .env.
 * Akan langsung melempar error dengan pesan jelas jika ada yang kurang.
 */
function _validateConfig() {
  const required = {
    EMAIL_HOST: IMAP_CONFIG.host,
    EMAIL_PORT: IMAP_CONFIG.port,
    EMAIL_USER: IMAP_CONFIG.user,
    EMAIL_PASS: IMAP_CONFIG.pass,
    OWNER_NUMBER: OWNER_NUMBER,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `[NetflixWatcher] Konfigurasi tidak lengkap! Variable berikut belum diisi di .env:\n  ${missing.join('\n  ')}`
    );
  }
}

export {
  startNetflixWatcher,
  stopNetflixWatcher,
  getWatcherStatus,
  getLastNetflixEmail,
  addToWaitingRoom,
  isInWaitingRoom,
};
