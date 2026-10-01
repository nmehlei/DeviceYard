export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  tlsMode: "tls" | "starttls" | "none";
  user?: string;
  password?: string;
  from: string;
  fromName: string;
  publicUrl: URL;
  connectionTimeoutMs: number;
  sendTimeoutMs: number;
}

export type NotificationConfig =
  | { enabled: false; status: "disabled" }
  | { enabled: false; status: "invalid"; error: NotificationConfigError }
  | { enabled: true; status: "ready"; config: SmtpConfig };

export type NotificationConfigError =
  | "incomplete"
  | "invalid-port"
  | "invalid-tls"
  | "credentials-incomplete"
  | "remote-tls-required"
  | "local-plaintext-not-enabled"
  | "invalid-sender"
  | "invalid-public-url"
  | "invalid-timeout";

const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_TLS", "SMTP_FROM", "PUBLIC_APP_URL"] as const;

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function invalid(error: NotificationConfigError): NotificationConfig {
  return { enabled: false, status: "invalid", error };
}

export function loadNotificationConfig(env: NodeJS.ProcessEnv): NotificationConfig {
  const present = required.some((key) => Boolean(env[key])) || Boolean(env.SMTP_USER) || Boolean(env.SMTP_PASSWORD);
  if (!present) return { enabled: false, status: "disabled" };
  if (required.some((key) => !env[key]?.trim())) return invalid("incomplete");

  const host = env.SMTP_HOST!.trim();
  const port = parseBoundedInt(env.SMTP_PORT, 0, 1, 65535);
  if (!port) return invalid("invalid-port");
  if (!(["tls", "starttls", "none"] as string[]).includes(env.SMTP_TLS!)) return invalid("invalid-tls");
  const tlsMode = env.SMTP_TLS as SmtpConfig["tlsMode"];
  const secure = tlsMode === "tls";
  const user = env.SMTP_USER?.trim() || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  if (Boolean(user) !== Boolean(password)) return invalid("credentials-incomplete");

  if (tlsMode === "none") {
    if (!isLoopback(host)) return invalid("remote-tls-required");
    if (env.NODE_ENV !== "development" || env.SMTP_ALLOW_LOCAL_PLAINTEXT !== "true") {
      return invalid("local-plaintext-not-enabled");
    }
  }

  const from = env.SMTP_FROM!.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from) || /[\r\n]/.test(from)) return invalid("invalid-sender");
  const fromName = (env.SMTP_FROM_NAME?.trim() || "DeviceYard").replace(/[\r\n\u0000-\u001f\u007f]/g, " ");

  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_APP_URL!);
    if (!(["https:", "http:"].includes(publicUrl.protocol)) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
      return invalid("invalid-public-url");
    }
    if (publicUrl.protocol !== "https:" && !isLoopback(publicUrl.hostname)) return invalid("invalid-public-url");
  } catch {
    return invalid("invalid-public-url");
  }

  const connectionTimeoutMs = parseBoundedInt(env.SMTP_CONNECTION_TIMEOUT_MS, 10_000, 1_000, 60_000);
  const sendTimeoutMs = parseBoundedInt(env.SMTP_SEND_TIMEOUT_MS, 15_000, 1_000, 60_000);
  if (!connectionTimeoutMs || !sendTimeoutMs) return invalid("invalid-timeout");

  return {
    enabled: true,
    status: "ready",
    config: { host, port, secure, tlsMode, user, password, from, fromName, publicUrl, connectionTimeoutMs, sendTimeoutMs },
  };
}
