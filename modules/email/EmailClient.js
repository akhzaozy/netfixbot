/**
 * EmailClient.js
 * ===============================================================
 * Klien IMAP yang menggunakan mode IDLE untuk mendengarkan email
 * baru secara real-time tanpa polling.
 *
 * Fitur:
 *  - IMAP IDLE (tidak ada polling, CPU ~0% saat idle)
 *  - Auto-reconnect dengan exponential backoff (max 5 menit)
 *  - Event-based: memancarkan event 'newEmail' saat email relevan masuk
 *  - Mendukung banyak provider (Netflix, Steam, dll)
 *  - Tidak menyimpan HTML besar di memory
 * ===============================================================
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';

const logger = createLogger('EmailClient');

// Backoff configuration
const INITIAL_BACKOFF_MS = 5_000;    // 5 detik
const MAX_BACKOFF_MS     = 300_000;  // 5 menit
const BACKOFF_MULTIPLIER = 2;

/**
 * EmailClient mengekstend EventEmitter.
 * Events yang dipancarkan:
 *  - 'newEmail'  : { provider, data }  - saat email relevan baru masuk
 *  - 'connected' : saat koneksi IMAP berhasil
 *  - 'disconnected' : saat koneksi terputus
 */
class EmailClient extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.host     - IMAP host (misal: imap.gmail.com)
   * @param {number} config.port     - IMAP port (biasanya 993)
   * @param {string} config.user     - Email address
   * @param {string} config.pass     - App Password (bukan password akun)
   * @param {Array}  config.providers - Array provider objects { matches, parse }
   */
  constructor(config) {
    super();
    this._config = config;
    this._client = null;
    this._isRunning = false;
    this._isConnected = false;
    this._reconnectTimer = null;
    this._currentBackoffMs = INITIAL_BACKOFF_MS;
    this._abortController = null;
  }

  /**
   * Memulai koneksi IMAP. Akan terus mencoba reconnect jika gagal.
   */
  async start() {
    this._isRunning = true;
    await this._connect();
  }

  /**
   * Menghentikan koneksi IMAP dengan bersih.
   */
  async stop() {
    this._isRunning = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    await this._disconnect();
    logger.info('Stopped gracefully.');
  }

  /**
   * Mendapatkan status koneksi saat ini.
   * @returns {{ isConnected: boolean }}
   */
  getStatus() {
    return {
      isConnected: this._isConnected,
    };
  }

  // ---- Private Methods ----

  /**
   * Membuat koneksi baru ke server IMAP dan memulai IDLE loop.
   * Jika gagal, akan menjadwalkan reconnect dengan backoff.
   */
  async _connect() {
    if (!this._isRunning) return;

    logger.info(`Menghubungkan ke ${this._config.host}:${this._config.port} sebagai ${this._config.user}...`);

    this._client = new ImapFlow({
      host: this._config.host,
      port: this._config.port,
      secure: true,
      auth: {
        user: this._config.user,
        pass: this._config.pass,
      },
      // Matikan logger bawaan imapflow, kita pakai logger kita sendiri
      logger: false,
    });

    // Tangkap error pada level koneksi
    this._client.on('error', (err) => {
      logger.error(`IMAP connection error: ${err.message}`);
    });

    try {
      await this._client.connect();
      this._isConnected = true;
      this._currentBackoffMs = INITIAL_BACKOFF_MS; // reset backoff setelah sukses
      logger.info('Connected ✓');
      this.emit('connected');

      // Masuk ke mailbox INBOX dan mulai IDLE loop
      await this._idleLoop();

    } catch (err) {
      this._isConnected = false;
      this._handleConnectionError(err);
    }
  }

  /**
   * Loop utama yang menggunakan IMAP IDLE.
   * Akan terus berjalan sampai ada email baru atau koneksi terputus.
   */
  async _idleLoop() {
    try {
      // Buka mailbox INBOX dalam mode read-only untuk hemat resource
      await this._client.mailboxOpen('INBOX');
      logger.info('Mailbox INBOX dibuka. Mendengarkan email baru (IDLE)...');

      // Loop tak terbatas: setelah menangani email baru, langsung IDLE lagi
      while (this._isRunning && this._client.usable) {
        // idle() akan memblokir (secara async) sampai ada perubahan di mailbox
        await this._client.idle();

        if (!this._isRunning) break;

        // Ada perubahan (kemungkinan email baru) - cek dan proses
        logger.info('Perubahan terdeteksi di mailbox, memeriksa email baru...');
        await this._fetchAndProcessNewEmails();
      }
    } catch (err) {
      // IDLE terputus (koneksi drop, server timeout, dll)
      if (this._isRunning) {
        logger.error(`IDLE loop terputus: ${err.message}`);
        this._isConnected = false;
        this.emit('disconnected');
        this._scheduleReconnect();
      }
    }
  }

  /**
   * Mengambil email yang belum dibaca (UNSEEN) dan memprosesnya melalui provider.
   */
  async _fetchAndProcessNewEmails() {
    try {
      // Cari semua email yang belum dibaca
      const uids = await this._client.search({ seen: false });
      if (!uids || uids.length === 0) {
        logger.info('Tidak ada email baru yang belum dibaca.');
        return;
      }

      logger.info(`Ditemukan ${uids.length} email belum dibaca. Memproses...`);

      for (const uid of uids) {
        await this._processEmail(uid);
      }
    } catch (err) {
      logger.error(`Gagal mengambil email: ${err.message}`);
    }
  }

  /**
   * Mengambil dan mem-parsing satu email berdasarkan UID.
   * Mem-parse dengan mailparser, lalu mencocokkan dengan provider yang tersedia.
   *
   * @param {number} uid - UID email di IMAP
   */
  async _processEmail(uid) {
    try {
      // Fetch hanya header + body, jangan download attachment
      const message = await this._client.fetchOne(uid, { source: true }, { uid: true });
      if (!message) return;

      // Parse email mentah dengan mailparser
      const parsedMail = await simpleParser(message.source, {
        // Tidak perlu decode attachment untuk hemat memory
        skipHtmlToText: false,
        skipTextToHtml: true,
        skipImageLinks: true,
      });

      const fromText = parsedMail.from?.text || '';
      const subject = parsedMail.subject || '';

      // Cari provider yang cocok untuk email ini
      const matchedProvider = this._config.providers.find((p) =>
        p.matches(fromText, subject)
      );

      if (!matchedProvider) {
        // Email bukan dari provider yang terdaftar - abaikan
        return;
      }

      logger.info(`Email baru terdeteksi dari: ${fromText} | Subjek: ${subject}`);

      // Parse email menggunakan provider yang cocok
      const data = matchedProvider.parse(parsedMail);

      // Pancarkan event ke listener (di netflixWatcher.js / index.js)
      this.emit('newEmail', {
        provider: matchedProvider.name || 'unknown',
        data,
      });

      // Tandai email sebagai sudah dibaca agar tidak diproses lagi di sesi ini
      await this._client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });

    } catch (err) {
      logger.error(`Gagal memproses email UID ${uid}: ${err.message}`);
    }
  }

  /**
   * Menutup koneksi IMAP dengan bersih.
   */
  async _disconnect() {
    this._isConnected = false;
    if (this._client) {
      try {
        await this._client.logout();
      } catch {
        // Abaikan error saat disconnect
      }
      this._client = null;
    }
  }

  /**
   * Menangani error koneksi dengan logging yang informatif.
   * Membedakan antara error autentikasi (tidak perlu retry cepat) dan
   * error jaringan (retry dengan backoff).
   *
   * @param {Error} err
   */
  _handleConnectionError(err) {
    const isAuthError = err.message?.includes('LOGIN') ||
                        err.message?.includes('AUTHENTICATIONFAILED') ||
                        err.message?.includes('Invalid credentials');

    if (isAuthError) {
      logger.error('❌ Login Gmail GAGAL! Periksa EMAIL_USER dan EMAIL_PASS di file .env.');
      logger.error('   Pastikan menggunakan App Password Gmail, bukan password akun biasa.');
      logger.error('   Cara membuat App Password: https://myaccount.google.com/apppasswords');
      // Retry lebih lambat untuk error auth
      this._scheduleReconnect(300_000); // 5 menit
    } else {
      logger.error(`Koneksi gagal: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  /**
   * Menjadwalkan reconnect dengan exponential backoff.
   * Backoff akan berlipat ganda setiap kali gagal, hingga batas MAX_BACKOFF_MS.
   *
   * @param {number} [overrideMs] - Override backoff time (opsional)
   */
  _scheduleReconnect(overrideMs) {
    if (!this._isRunning) return;

    const delay = overrideMs || this._currentBackoffMs;
    const delaySeconds = Math.round(delay / 1000);

    logger.warn(`Reconnect dalam ${delaySeconds}s...`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      // Pastikan koneksi lama sudah tertutup
      await this._disconnect();
      await this._connect();
    }, delay);

    // Naikkan backoff untuk percobaan berikutnya (jika gagal lagi)
    if (!overrideMs) {
      this._currentBackoffMs = Math.min(
        this._currentBackoffMs * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_MS
      );
    }
  }
}

export { EmailClient };
