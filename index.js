/**
 * index.js
 * ===============================================================
 * Entry point AutoNetflix — Mode Auto-Confirm tanpa WhatsApp.
 *
 * Yang terjadi:
 *  1. Konek ke Gmail via IMAP IDLE (real-time, tanpa polling)
 *  2. Saat email dari Netflix masuk → ekstrak URL konfirmasi
 *  3. Otomatis kunjungi URL tersebut → konfirmasi selesai
 *  4. Catat ke cache.json agar tidak diproses dua kali
 *
 * Tidak ada Baileys, tidak ada WhatsApp, tidak ada QR code.
 * ===============================================================
 */

import 'dotenv/config';
import { startNetflixWatcher, stopNetflixWatcher } from './modules/netflixWatcher.js';
import { createLogger } from './modules/logger.js';

const logger = createLogger('App');

// ====================================================================
// GRACEFUL SHUTDOWN
// ====================================================================
async function shutdown(signal) {
  logger.info(`${signal} diterima, mematikan dengan bersih...`);
  await stopNetflixWatcher();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Tangkap error tak terduga agar tidak crash diam-diam
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

// ====================================================================
// MAIN
// ====================================================================
logger.info('========================================');
logger.info(' AutoNetflix — Email Auto-Confirm Bot   ');
logger.info('========================================');
logger.info('Mode: Auto-Confirm (tanpa WhatsApp)');
logger.info('Memulai...');

// Jalankan watcher tanpa sendMessage (null = tidak kirim WA)
startNetflixWatcher({ sendMessage: null }).catch((err) => {
  logger.error(`Fatal error saat start: ${err.message}`);
  process.exit(1);
});
