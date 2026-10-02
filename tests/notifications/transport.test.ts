import { SmtpConfig } from "../../src/notifications/config";
import { createSmtpTransport, EmailTransportError } from "../../src/notifications/transport";
import { createServer } from "net";

const config: SmtpConfig = { host: "smtp.example.com", port: 465, secure: true, tlsMode: "tls", user: "smtp-user", password: "stored-password", from: "mail@example.com", fromName: "DeviceYard", publicUrl: new URL("https://deviceyard.example.com"), connectionTimeoutMs: 4000, sendTimeoutMs: 5000 };
const message = { id: "event-123", to: "alex@example.com", subject: "Run complete", html: "<p>Done</p>", text: "Done" };

describe("SMTP transport", () => {
  it("configures bounded timeouts, no external content access, multipart bodies and stable Message-ID", async () => {
    const sendMail = jest.fn().mockResolvedValue({ accepted: ["alex@example.com"], rejected: [] });
    const factory = jest.fn(() => ({ sendMail })) as never;
    const transport = createSmtpTransport(config, factory);
    await transport.send(message);
    await transport.send(message);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeout: 4000, socketTimeout: 5000, disableFileAccess: true, disableUrlAccess: true, socket: expect.anything() }));
    expect(sendMail.mock.calls[0][0]).toMatchObject({ html: message.html, text: message.text, disableFileAccess: true, disableUrlAccess: true });
    expect(sendMail.mock.calls[0][0].messageId).toBe(sendMail.mock.calls[1][0].messageId);
    expect(sendMail.mock.calls[0][0].messageId).not.toContain(message.id);
  });

  it("fails if any recipient is rejected", async () => {
    const transport = createSmtpTransport(config, (() => ({ sendMail: jest.fn().mockResolvedValue({ accepted: [], rejected: ["alex@example.com"] }) })) as never);
    await expect(transport.send(message)).rejects.toMatchObject({ code: "recipient-rejected" });
  });

  it("requires STARTTLS only in starttls mode", async () => {
    const tlsFactory = jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ rejected: [] }) })) as never;
    await createSmtpTransport({ ...config, secure: false, tlsMode: "starttls" }, tlsFactory).send(message);
    expect(tlsFactory).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
    const plainFactory = jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ rejected: [] }) })) as never;
    await createSmtpTransport({ ...config, host: "localhost", secure: false, tlsMode: "none" }, plainFactory).send(message);
    expect(plainFactory).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: false }));
  });

  it("sanitizes provider errors", async () => {
    const transport = createSmtpTransport(config, (() => ({ sendMail: jest.fn().mockRejectedValue(Object.assign(new Error("provider said secret details"), { code: "ETIMEDOUT", response: "private response" })) })) as never);
    const error = await transport.send(message).catch((caught) => caught as EmailTransportError);
    expect(error).toMatchObject({ code: "timeout", message: "timeout" });
    expect(JSON.stringify(error)).not.toContain("private response");
  });

  it.each([
    [450, "transport-failed"],
    [550, "recipient-rejected"],
  ])("maps SMTP envelope response %i to %s", async (responseCode, expectedCode) => {
    const providerError = Object.assign(new Error("provider response must stay private"), {
      code: "EENVELOPE",
      responseCode,
      response: "private response",
    });
    const transport = createSmtpTransport(config, (() => ({ sendMail: jest.fn().mockRejectedValue(providerError) })) as never);
    const error = await transport.send(message).catch((caught) => caught as EmailTransportError);
    expect(error).toMatchObject({ code: expectedCode, message: expectedCode });
    expect(JSON.stringify(error)).not.toContain("private response");
  });

  it("retries temporary SMTP authentication responses", async () => {
    const providerError = Object.assign(new Error("temporary authentication failure"), { code: "EAUTH", responseCode: 454 });
    const transport = createSmtpTransport(config, (() => ({ sendMail: jest.fn().mockRejectedValue(providerError) })) as never);
    await expect(transport.send(message)).rejects.toMatchObject({ code: "transport-failed" });
  });

  it("closes the SMTP connection at the total send deadline", async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    const transport = createSmtpTransport({ ...config, sendTimeoutMs: 1000 }, (() => ({ sendMail: jest.fn(() => new Promise(() => undefined)), close })) as never);
    const pending = transport.send(message);
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await jest.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(close).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("actually disconnects a stalled local SMTP peer at the deadline", async () => {
    let peerClosed!: () => void;
    const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
    const server = createServer((socket) => socket.once("close", peerClosed));
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const transport = createSmtpTransport({ ...config, host: "127.0.0.1", port: address.port, secure: false, tlsMode: "none", connectionTimeoutMs: 1000, sendTimeoutMs: 100 });
    await expect(transport.send(message)).rejects.toMatchObject({ code: "timeout" });
    await expect(Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))])).resolves.toBe(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects header injection before transport", async () => {
    const sendMail = jest.fn();
    const transport = createSmtpTransport(config, (() => ({ sendMail })) as never);
    await expect(transport.send({ ...message, subject: "Hi\r\nBcc: attacker@example.com" })).rejects.toMatchObject({ code: "invalid-message" });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
