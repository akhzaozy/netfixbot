/**
 * NetflixProvider.js
 * ===============================================================
 * Provider parser khusus untuk email dari Netflix.
 *
 * ARSITEKTUR MODULAR:
 * File ini adalah contoh "provider" yang bisa Anda duplikasi untuk
 * membuat parser email dari provider lain, misalnya:
 *   - modules/email/providers/GithubProvider.js
 *   - modules/email/providers/SteamProvider.js
 *   - modules/email/providers/GoogleProvider.js
 *
 * Setiap provider WAJIB mengekspor dua hal:
 *   1. matches(from, subject) -> boolean  : Apakah email ini relevan?
 *   2. parse(parsedMail)     -> object   : Ekstrak data dari email
 * ===============================================================
 */

import { JSDOM } from 'jsdom';

// ---- Identifikasi pengirim Netflix ----
const NETFLIX_SENDERS = [
  'netflix.com',
  'info@account.netflix.com',
  'info@members.netflix.com',
  'no-reply@netflix.com',
];

/**
 * Pola keyword pada URL yang kemungkinan besar adalah tombol konfirmasi.
 * Netflix sering menggunakan path seperti /account/update, /account/travel, dll.
 */
const CONFIRM_URL_PATTERNS = [
  /netflix\.com\/account\//i,
  /netflix\.com\/loginhelp/i,
  /netflix\.com\/YourAccount/i,
  /netflix\.com\/browse/i,
  /netflix\.com\/password/i,
  /netflix\.com\/changehousehold/i,
  /netflix\.com\/your-account/i,
];

/**
 * Keyword pada teks anchor/button yang menandakan tombol konfirmasi.
 */
const CONFIRM_BUTTON_TEXTS = [
  /perbarui/i,
  /konfirmasi/i,
  /verifikasi/i,
  /update/i,
  /confirm/i,
  /verify/i,
  /yes, this was me/i,
  /yes, i traveled/i,
  /change household/i,
  /selesai/i,
  /klik di sini/i,
  /click here/i,
];

/**
 * Mengecek apakah sebuah email berasal dari Netflix.
 * Dipanggil oleh EmailClient untuk memfilter email masuk.
 *
 * @param {string} from - Alamat email pengirim (misal: "Netflix <info@account.netflix.com>")
 * @param {string} subject - Subjek email
 * @returns {boolean}
 */
function matches(from, subject) {
  const fromLower = (from || '').toLowerCase();
  const isFromNetflix = NETFLIX_SENDERS.some((sender) => fromLower.includes(sender));
  return isFromNetflix;
}

/**
 * Mem-parsing objek email yang sudah diparse oleh mailparser.
 * Mengekstrak URL konfirmasi dari konten HTML/text email.
 *
 * @param {import('mailparser').ParsedMail} parsedMail - Hasil parse dari mailparser
 * @returns {{
 *   messageId: string,
 *   subject: string,
 *   from: string,
 *   date: string,
 *   confirmUrl: string|null,
 *   rawText: string|null,
 * }}
 */
function parse(parsedMail) {
  const messageId = parsedMail.messageId || `fallback-${Date.now()}`;
  const subject = parsedMail.subject || '(Tanpa Subjek)';
  const from = parsedMail.from?.text || 'Unknown';
  const date = parsedMail.date ? parsedMail.date.toISOString() : new Date().toISOString();

  // Cari URL konfirmasi dari HTML terlebih dahulu, baru dari text plain
  let confirmUrl = null;

  if (parsedMail.html) {
    confirmUrl = _extractUrlFromHtml(parsedMail.html);
  }

  if (!confirmUrl && parsedMail.text) {
    confirmUrl = _extractUrlFromText(parsedMail.text);
  }

  return {
    messageId,
    subject,
    from,
    date,
    confirmUrl,
    // Simpan text pendek saja, hindari simpan HTML besar di memory
    rawText: parsedMail.text ? parsedMail.text.slice(0, 500) : null,
  };
}

/**
 * Ekstrak URL konfirmasi dari konten HTML email menggunakan JSDOM.
 * Strategi:
 *  1. Cari semua tag <a> dengan href yang cocok dengan pola Netflix
 *  2. Prioritaskan <a> yang teks/konteksnya mengandung keyword konfirmasi
 *  3. Fallback: ambil URL Netflix pertama yang ditemukan
 *
 * @param {string} html
 * @returns {string|null}
 */
function _extractUrlFromHtml(html) {
  // Batasi ukuran HTML yang diproses untuk hemat memory
  const truncatedHtml = html.slice(0, 500_000);

  let dom;
  try {
    dom = new JSDOM(truncatedHtml);
  } catch {
    return null;
  }

  const anchors = Array.from(dom.window.document.querySelectorAll('a[href]'));

  // Tahap 1: Cari anchor dengan teks yang mengandung keyword konfirmasi
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const text = anchor.textContent?.trim() || '';

    const isNetflixUrl = CONFIRM_URL_PATTERNS.some((p) => p.test(href));
    const isConfirmText = CONFIRM_BUTTON_TEXTS.some((p) => p.test(text));

    if (isNetflixUrl && isConfirmText) {
      return _sanitizeUrl(href);
    }
  }

  // Tahap 2 (fallback): Cari URL pertama yang cocok dengan pola Netflix
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const isNetflixUrl = CONFIRM_URL_PATTERNS.some((p) => p.test(href));
    if (isNetflixUrl) {
      return _sanitizeUrl(href);
    }
  }

  // Tahap 3 (fallback): Cari semua URL netflix.com apapun
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    if (href.includes('netflix.com') && href.startsWith('http')) {
      return _sanitizeUrl(href);
    }
  }

  return null;
}

/**
 * Ekstrak URL konfirmasi dari teks plain email menggunakan regex.
 * Digunakan sebagai fallback jika HTML tidak tersedia atau tidak mengandung URL.
 *
 * @param {string} text
 * @returns {string|null}
 */
function _extractUrlFromText(text) {
  const urlRegex = /https?:\/\/[^\s<>"]+netflix\.com[^\s<>"]+/gi;
  const matches = text.match(urlRegex);
  if (!matches) return null;

  // Prioritaskan URL yang cocok dengan pola konfirmasi
  for (const url of matches) {
    if (CONFIRM_URL_PATTERNS.some((p) => p.test(url))) {
      return _sanitizeUrl(url);
    }
  }

  return _sanitizeUrl(matches[0]);
}

/**
 * Membersihkan URL dari karakter trailing yang tidak diinginkan.
 * @param {string} url
 * @returns {string}
 */
function _sanitizeUrl(url) {
  // Hapus trailing punctuation yang mungkin terbawa dari text parsing
  return url.replace(/[.,;)\]'"]+$/, '');
}

export { matches, parse };
