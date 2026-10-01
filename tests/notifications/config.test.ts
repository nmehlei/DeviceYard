import { loadNotificationConfig } from "../../src/notifications/config";

const valid = { SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_TLS: "tls", SMTP_FROM: "notifications@example.com", SMTP_FROM_NAME: "DeviceYard", PUBLIC_APP_URL: "https://deviceyard.example.com" };

describe("loadNotificationConfig", () => {
  it("is safely disabled when unconfigured", () => expect(loadNotificationConfig({})).toEqual({ enabled: false, status: "disabled" }));
  it("returns safe invalid states instead of throwing for partial config", () => expect(loadNotificationConfig({ SMTP_HOST: "smtp.example.com" })).toEqual({ enabled: false, status: "invalid", error: "incomplete" }));
  it("loads complete TLS configuration", () => expect(loadNotificationConfig(valid)).toMatchObject({ enabled: true, config: { host: "smtp.example.com", port: 465, secure: true, from: "notifications@example.com" } }));
  it("supports mandatory remote STARTTLS without downgrade", () => expect(loadNotificationConfig({ ...valid, SMTP_TLS: "starttls", SMTP_PORT: "587" })).toMatchObject({ enabled: true, config: { secure: false, tlsMode: "starttls" } }));
  it("requires TLS for remote SMTP", () => expect(loadNotificationConfig({ ...valid, SMTP_TLS: "none" })).toMatchObject({ enabled: false, error: "remote-tls-required" }));
  it("allows explicit development plaintext only on loopback", () => expect(loadNotificationConfig({ ...valid, SMTP_HOST: "127.0.0.1", SMTP_PORT: "1025", SMTP_TLS: "none", SMTP_ALLOW_LOCAL_PLAINTEXT: "true", PUBLIC_APP_URL: "http://localhost:3000", NODE_ENV: "development" })).toMatchObject({ enabled: true, config: { secure: false, tlsMode: "none" } }));
  it("rejects local plaintext when NODE_ENV is unset", () => expect(loadNotificationConfig({ ...valid, SMTP_HOST: "localhost", SMTP_TLS: "none", SMTP_ALLOW_LOCAL_PLAINTEXT: "true" })).toMatchObject({ enabled: false, error: "local-plaintext-not-enabled" }));
  it("rejects local plaintext in production", () => expect(loadNotificationConfig({ ...valid, SMTP_HOST: "localhost", SMTP_TLS: "none", SMTP_ALLOW_LOCAL_PLAINTEXT: "true", NODE_ENV: "production" })).toMatchObject({ enabled: false, error: "local-plaintext-not-enabled" }));
  it("requires paired credentials", () => expect(loadNotificationConfig({ ...valid, SMTP_USER: "user" })).toMatchObject({ enabled: false, error: "credentials-incomplete" }));
  it.each(["javascript:alert(1)", "https://user:pass@example.com", "https://example.com/?tenant=x", "http://remote.example.com"])("rejects untrusted public URL %s", (PUBLIC_APP_URL) => expect(loadNotificationConfig({ ...valid, PUBLIC_APP_URL })).toMatchObject({ enabled: false, error: "invalid-public-url" }));
});
