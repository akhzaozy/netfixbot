/**
 * CacheHelper.js
 * ===============================================================
 * Modul untuk menyimpan dan membaca state email terakhir yang
 * sudah diproses. Menggunakan file JSON sederhana agar ringan
 * dan tidak memerlukan database eksternal.
 *
 * Data yang disimpan:
 *  - messageId    : Message-ID dari email (sebagai unique identifier)
 *  - subject      : Subjek email
 *  - from         : Pengirim email
 *  - date         : Tanggal email
 *  - confirmUrl   : URL konfirmasi yang diekstrak
 *  - processedAt  : Waktu saat email diproses oleh bot
 *  - syncedAt     : Waktu koneksi IMAP terakhir berhasil
 *  - emailCount   : Total email Netflix yang sudah diproses
 * ===============================================================
 */

import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import path from 'path';

const CACHE_FILE = path.resolve('cache.json');

/**
 * State default cache saat pertama kali dijalankan atau file tidak ada.
 */
const DEFAULT_CACHE = {
  messageId: null,
  subject: null,
  from: null,
  date: null,
  confirmUrl: null,
  processedAt: null,
  syncedAt: null,
  emailCount: 0,
};

/**
 * Membaca cache dari disk. Mengembalikan DEFAULT_CACHE jika file
 * belum ada atau rusak (corrupt), sehingga tidak akan crash.
 * @returns {Promise<object>}
 */
async function readCache() {
  try {
    // Cek apakah file ada terlebih dahulu
    await access(CACHE_FILE, constants.F_OK);
    const raw = await readFile(CACHE_FILE, 'utf-8');
    return { ...DEFAULT_CACHE, ...JSON.parse(raw) };
  } catch {
    // File tidak ada atau JSON corrupt - kembalikan default
    return { ...DEFAULT_CACHE };
  }
}

/**
 * Menulis data ke cache. Operasi ini atomic: data dibaca dulu,
 * di-merge dengan data baru, lalu ditulis kembali.
 * @param {Partial<typeof DEFAULT_CACHE>} data - Data yang akan di-update
 * @returns {Promise<object>} Cache terbaru setelah update
 */
async function writeCache(data) {
  const current = await readCache();
  const updated = { ...current, ...data };
  await writeFile(CACHE_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

/**
 * Mengecek apakah sebuah email (berdasarkan messageId) sudah pernah diproses.
 * Ini mencegah notifikasi WhatsApp dikirim dua kali untuk email yang sama.
 * @param {string} messageId - Message-ID dari header email
 * @returns {Promise<boolean>}
 */
async function isAlreadyProcessed(messageId) {
  if (!messageId) return false;
  const cache = await readCache();
  return cache.messageId === messageId;
}

/**
 * Menyimpan email yang baru saja berhasil diproses.
 * Juga menambahkan counter emailCount.
 * @param {object} emailData - Data email yang sudah diparse
 * @param {string} emailData.messageId
 * @param {string} emailData.subject
 * @param {string} emailData.from
 * @param {string} emailData.date
 * @param {string|null} emailData.confirmUrl
 * @returns {Promise<object>} Cache terbaru
 */
async function markAsProcessed(emailData) {
  const current = await readCache();
  return writeCache({
    messageId: emailData.messageId,
    subject: emailData.subject,
    from: emailData.from,
    date: emailData.date,
    confirmUrl: emailData.confirmUrl || null,
    processedAt: new Date().toISOString(),
    emailCount: (current.emailCount || 0) + 1,
  });
}

/**
 * Memperbarui timestamp sinkronisasi IMAP terakhir.
 * Dipanggil setiap kali koneksi IMAP berhasil dibuat.
 * @returns {Promise<void>}
 */
async function updateSyncTime() {
  await writeCache({ syncedAt: new Date().toISOString() });
}

export { readCache, writeCache, isAlreadyProcessed, markAsProcessed, updateSyncTime };
