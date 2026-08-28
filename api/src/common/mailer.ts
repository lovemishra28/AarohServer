import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { describeError } from './errors';
import { logger } from './logger';
import { env } from '../config/env';

/**
 * Outbound email — used only by the email-OTP flows (verification codes, email
 * login codes, password resets).
 *
 * Two transports, chosen by MAIL_TRANSPORT:
 *
 *  - **console** (default): writes the message to the log instead of sending it.
 *    This is the email twin of the SMS dev stub — the whole email-OTP flow is
 *    testable end to end with no provider account, and no code path differs
 *    between dev and prod except which transport runs.
 *  - **smtp**: speaks SMTP directly over `node:net`/`node:tls`.
 *
 * The SMTP client is hand-rolled for the same reason `common/jwt.ts` and
 * `common/password.ts` are: this project adds no third-party dependency it can
 * implement from the standard library. It covers exactly what transactional mail
 * needs — EHLO, optional STARTTLS upgrade, AUTH PLAIN/LOGIN, one MAIL FROM, one
 * RCPT TO, a base64 UTF-8 body — and nothing else. It is not a general mail
 * library: no pooling, no attachments, no multiple recipients.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Sent as UTF-8, base64-encoded, so Hindi text survives. */
  text: string;
}

/** RFC 2047 encoded-word, so non-ASCII subjects (Hindi) are not mangled. */
function encodeHeader(value: string): string {
  const isPrintableAscii = [...value].every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e;
  });
  if (isPrintableAscii) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Extract the bare address from either "Name <a@b>" or "a@b". */
function bareAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim();
}

function buildMime(msg: MailMessage): string {
  // A base64 body sidesteps SMTP's two classic line-level hazards at once:
  // the 998-octet line limit and dot-stuffing (a line consisting of a single
  // "." would end DATA early). base64's alphabet cannot produce such a line.
  const body = Buffer.from(msg.text, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  return [
    `From: ${env.MAIL_FROM}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${hostname()}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** One SMTP reply: the numeric code plus every text line of a multi-line reply. */
interface SmtpReply {
  code: number;
  lines: string[];
}

class SmtpError extends Error {}

/**
 * A single SMTP conversation. Deliberately one-shot: construct, `send`, done.
 *
 * The read side buffers bytes and only resolves once a *complete* reply has
 * arrived, because SMTP replies are multi-line (`250-EXTENSION` continues,
 * `250 OK` terminates) and TCP gives no guarantee that a reply lands in one
 * `data` event.
 */
class SmtpSession {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private waiting: {
    resolve: (reply: SmtpReply) => void;
    reject: (err: Error) => void;
  } | null = null;
  private failure: Error | null = null;
  private closed = false;

  private constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding('utf8');
    socket.setTimeout(env.SMTP_TIMEOUT_MS);
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('timeout', () => this.fail(new SmtpError('SMTP timeout')));
    socket.on('close', () => {
      this.closed = true;
      if (this.waiting) this.fail(new SmtpError('SMTP connection closed early'));
    });
  }

  private fail(err: Error): void {
    this.failure ??= err;
    const waiter = this.waiting;
    this.waiting = null;
    waiter?.reject(err);
  }

  /** Emit a reply if the buffer now holds a terminated one. */
  private drain(): void {
    while (this.waiting) {
      const lines = this.buffer.split('\r\n');
      // The last element is an incomplete line (or '' after a trailing CRLF).
      const complete = lines.slice(0, -1);
      // A reply ends at the first line whose 4th character is a space.
      const endIndex = complete.findIndex((line) => line.length >= 4 && line[3] === ' ');
      if (endIndex === -1) return;

      const replyLines = complete.slice(0, endIndex + 1);
      const consumed = replyLines.join('\r\n').length + 2;
      this.buffer = this.buffer.slice(consumed);

      const code = Number(replyLines[endIndex].slice(0, 3));
      const waiter = this.waiting;
      this.waiting = null;
      waiter.resolve({ code, lines: replyLines.map((line) => line.slice(4)) });
    }
  }

  private read(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<SmtpReply>((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.drain();
    });
  }

  private write(line: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`);
  }

  /** Send a command and assert the reply code is one we expect. */
  private async command(line: string, expected: number[], redact = false): Promise<SmtpReply> {
    this.write(line);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      const shown = redact ? '<redacted>' : line;
      throw new SmtpError(`SMTP ${shown} → ${reply.code} ${reply.lines.join(' | ')}`);
    }
    return reply;
  }

  private static openSocket(): Promise<Socket | TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      if (env.SMTP_SECURE) {
        const socket = tlsConnect(
          { host: env.SMTP_HOST, port: env.SMTP_PORT, servername: env.SMTP_HOST },
          () => {
            socket.removeListener('error', onError);
            resolve(socket);
          },
        );
        socket.once('error', onError);
      } else {
        const socket = netConnect({ host: env.SMTP_HOST, port: env.SMTP_PORT }, () => {
          socket.removeListener('error', onError);
          resolve(socket);
        });
        socket.once('error', onError);
      }
    });
  }

  /** Upgrade an in-place plaintext connection to TLS (STARTTLS, port 587). */
  private upgrade(): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('timeout');
      plain.removeAllListeners('close');
      plain.setTimeout(0);

      const secure = tlsConnect({ socket: plain as Socket, servername: env.SMTP_HOST }, () => {
        secure.removeListener('error', reject);
        this.socket = secure;
        this.buffer = '';
        this.attach(secure);
        resolve();
      });
      secure.once('error', reject);
    });
  }

  static async deliver(msg: MailMessage): Promise<void> {
    const session = new SmtpSession(await SmtpSession.openSocket());
    try {
      const greeting = await session.read();
      if (greeting.code !== 220) {
        throw new SmtpError(`SMTP greeting → ${greeting.code} ${greeting.lines.join(' | ')}`);
      }

      const me = hostname() || 'localhost';
      let ehlo = await session.command(`EHLO ${me}`, [250]);

      if (!env.SMTP_SECURE) {
        const offersStartTls = ehlo.lines.some((line) => /^STARTTLS\b/i.test(line));
        if (offersStartTls) {
          await session.command('STARTTLS', [220]);
          await session.upgrade();
          // The extension list must be re-read: what a server advertises before
          // and after the TLS upgrade differs (AUTH usually appears only after).
          ehlo = await session.command(`EHLO ${me}`, [250]);
        } else if (env.SMTP_PASS) {
          throw new SmtpError(
            'SMTP server does not offer STARTTLS; refusing to send credentials over plaintext',
          );
        }
      }

      if (env.SMTP_USER) {
        const authLine = ehlo.lines.find((line) => /^AUTH\b/i.test(line)) ?? '';
        const mechanisms = authLine.toUpperCase();
        if (mechanisms.includes('PLAIN') || mechanisms === '') {
          const payload = Buffer.from(`\0${env.SMTP_USER}\0${env.SMTP_PASS}`, 'utf8').toString(
            'base64',
          );
          await session.command(`AUTH PLAIN ${payload}`, [235], true);
        } else if (mechanisms.includes('LOGIN')) {
          await session.command('AUTH LOGIN', [334]);
          await session.command(Buffer.from(env.SMTP_USER, 'utf8').toString('base64'), [334], true);
          await session.command(Buffer.from(env.SMTP_PASS, 'utf8').toString('base64'), [235], true);
        } else {
          throw new SmtpError(`No supported SMTP AUTH mechanism (server offered: ${authLine})`);
        }
      }

      await session.command(`MAIL FROM:<${bareAddress(env.MAIL_FROM)}>`, [250]);
      await session.command(`RCPT TO:<${bareAddress(msg.to)}>`, [250, 251]);
      await session.command('DATA', [354]);
      session.write(buildMime(msg));
      await session.command('.', [250]);
      try {
        await session.command('QUIT', [221]);
      } catch {
        // The message is already accepted at this point; a rude disconnect on
        // QUIT is not a delivery failure.
      }
    } finally {
      if (!session.closed) session.socket.destroy();
    }
  }
}

/**
 * Send one message. Rejects on failure — callers decide whether that is fatal.
 * The OTP services treat a send failure as fatal *before* telling the user a code
 * was sent, so nobody is left waiting for mail that never left the building.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  if (env.MAIL_TRANSPORT === 'console') {
    // Stands in for the provider. This is the dev equivalent of opening the inbox.
    logger.info('mail_console', { to: msg.to, subject: msg.subject, body: msg.text });
    return;
  }

  if (!env.SMTP_HOST) {
    throw new Error('MAIL_TRANSPORT=smtp but SMTP_HOST is empty');
  }

  try {
    await SmtpSession.deliver(msg);
    logger.info('mail_sent', { to: msg.to, subject: msg.subject });
  } catch (err) {
    logger.error('mail_send_failed', { to: msg.to, ...describeError(err) });
    throw err;
  }
}
