/**
 * logger.js
 * ===============================================================
 * Factory function untuk membuat logger yang konsisten di seluruh modul.
 * Menggunakan pino untuk performa tinggi.
 *
 * Format output:
 *   [ModuleName] Pesan log
 * ===============================================================
 */

import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

// Logger root dengan konfigurasi global
const rootLogger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
  },
  isDevelopment
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:dd mmm yyyy HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '[{module}] {msg}',
        },
      })
    : process.stdout
);

/**
 * Membuat logger dengan nama modul tertentu.
 * @param {string} moduleName - Nama modul untuk ditampilkan di log
 * @returns {import('pino').Logger}
 *
 * @example
 * const logger = createLogger('NetflixWatcher');
 * logger.info('Connected');
 * // Output: [NetflixWatcher] Connected
 */
function createLogger(moduleName) {
  return rootLogger.child({ module: moduleName });
}

export { createLogger };
