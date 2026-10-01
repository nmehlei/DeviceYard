import { createHash } from "crypto";
import { Socket } from "net";
import nodemailer, { Transporter } from "nodemailer";
import { SmtpConfig } from "./config";

export interface EmailMessage { id: string; to: string; subject: string; html: string; text: string }
export interface EmailTransport { send(message: EmailMessage): Promise<void> }
export type EmailTransportErrorCode = "invalid-message" | "recipient-rejected" | "authentication-failed" | "timeout" | "transport-failed";

export class EmailTransportError extends Error {
  constructor(public readonly code: EmailTransportErrorCode) { super(code); this.name = "EmailTransportError"; }
}

type SendTransport = Pick<Transporter, "sendMail"> & { close?: () => void };
type TransportFactory = (options: Record<string, unknown>) => SendTransport;

function stableMessageId(id: string): string {
  return `<${createHash("sha256").update(id).digest("hex")}@deviceyard.local>`;
}

function mapError(error: unknown): EmailTransportError {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const responseCode = typeof error === "object" && error !== null && "responseCode" in error && typeof (error as { responseCode: unknown }).responseCode === "number"
    ? (error as { responseCode: number }).responseCode
    : undefined;
  if (responseCode !== undefined && responseCode >= 400 && responseCode <= 499) return new EmailTransportError("transport-failed");
  if (code === "EENVELOPE") return new EmailTransportError("recipient-rejected");
  if (code === "EAUTH") return new EmailTransportError("authentication-failed");
  if (["ETIMEDOUT", "ESOCKET"].includes(code)) return new EmailTransportError("timeout");
  return new EmailTransportError("transport-failed");
}

export function createSmtpTransport(config: SmtpConfig, factory: TransportFactory = nodemailer.createTransport): EmailTransport {
  return {
    async send(message) {
      if (!message.id || /[\r\n]/.test(message.to) || /[\r\n]/.test(message.subject) || !message.html || !message.text) throw new EmailTransportError("invalid-message");
      // A caller-owned socket lets the total deadline abort DNS/connect, TLS, and DATA.
      // Nodemailer connects and (for implicit TLS) upgrades this socket itself.
      const socket = new Socket();
      const transporter = factory({
        host: config.host, port: config.port, secure: config.secure, socket,
        requireTLS: config.tlsMode === "starttls", connectionTimeout: config.connectionTimeoutMs,
        greetingTimeout: config.connectionTimeoutMs, socketTimeout: config.sendTimeoutMs,
        auth: config.user ? { user: config.user, pass: config.password } : undefined,
        disableFileAccess: true, disableUrlAccess: true,
      });
      try {
        const result = await new Promise<{ rejected?: unknown[] }>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            transporter.close?.();
            reject(new EmailTransportError("timeout"));
          }, config.sendTimeoutMs);
          transporter.sendMail({
            from: { address: config.from, name: config.fromName }, to: message.to,
            subject: message.subject, html: message.html, text: message.text,
            messageId: stableMessageId(message.id), disableFileAccess: true, disableUrlAccess: true,
          }).then((value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value as { rejected?: unknown[] });
          }, (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          });
        });
        const rejected = result.rejected;
        if (rejected && rejected.length > 0) throw new EmailTransportError("recipient-rejected");
      } catch (error) {
        if (error instanceof EmailTransportError) throw error;
        throw mapError(error);
      } finally {
        socket.destroy();
        transporter.close?.();
      }
    },
  };
}
