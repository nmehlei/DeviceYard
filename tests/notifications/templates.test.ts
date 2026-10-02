import { renderEmail, sampleEmail, TemplateKind } from "../../src/notifications/templates";

const kinds: TemplateKind[] = ["run-result", "invitation", "password-reset", "email-verification", "device-offline", "device-recovered", "test"];

describe("email templates", () => {
  it.each(kinds)("renders HTML and text for %s", (kind) => {
    const rendered = renderEmail(sampleEmail(kind), "https://deviceyard.example.com", { preview: true });
    expect(rendered.html).toContain("<!doctype html>");
    expect(rendered.html).toContain("Device");
    expect(rendered.html).toContain("max-width:600px");
    expect(rendered.text.length).toBeGreaterThan(40);
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html).not.toContain('href="');
  });

  it("escapes hostile dynamic HTML", () => {
    const data = { ...sampleEmail("test"), recipientName: '<script>alert("x")</script>' };
    const rendered = renderEmail(data, "https://deviceyard.example.com");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).not.toContain("<script>");
  });

  it("rejects action links outside the trusted origin", () => expect(() => renderEmail({ ...sampleEmail("password-reset"), actionUrl: "https://evil.example/reset" }, "https://deviceyard.example.com")).toThrow("untrusted-action-url"));

  it("prevents subject header injection", () => {
    const sample = sampleEmail("device-offline");
    if (sample.kind !== "device-offline") throw new Error("fixture kind mismatch");
    const rendered = renderEmail({ ...sample, deviceName: "Pixel\r\nBcc: attacker@example.com" }, "https://deviceyard.example.com");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it("caps failed flow names", () => {
    const sample = sampleEmail("run-result");
    if (sample.kind !== "run-result") throw new Error("fixture kind mismatch");
    const rendered = renderEmail({ ...sample, failedFlowNames: ["one", "two", "three", "four", "five", "six", "seven"] }, "https://deviceyard.example.com");
    expect(rendered.html).toContain("and 2 more");
    expect(rendered.html).not.toContain("six");
  });

  it("links optional notification emails to the implemented preferences page", () => {
    const rendered = renderEmail(sampleEmail("device-offline"), "https://deviceyard.example.com");
    expect(rendered.html).toContain('href="https://deviceyard.example.com/notifications"');
    expect(rendered.text).toContain("Manage notification preferences: https://deviceyard.example.com/notifications");
  });

  it("uses only synthetic non-actionable sample paths", () => {
    for (const kind of kinds) {
      const sample = sampleEmail(kind);
      expect(sample.actionUrl).toBe("/preview/example");
      expect(JSON.stringify(sample)).not.toMatch(/token|secret|bearer/i);
    }
  });
});
