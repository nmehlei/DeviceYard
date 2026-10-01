import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

export type TemplateKind = "run-result" | "invitation" | "password-reset" | "email-verification" | "device-offline" | "device-recovered" | "test";

type Action = { actionUrl: string };
export type EmailData =
  | ({ kind: "run-result"; recipientName: string; organisationName: string; jobId: string; result: "passed" | "failed"; duration: string; passedFlows: number; failedFlows: number; failedFlowNames: string[] } & Action)
  | ({ kind: "invitation"; recipientName: string; organisationName: string; inviterName: string; expiresIn: string } & Action)
  | ({ kind: "password-reset"; recipientName: string; expiresIn: string } & Action)
  | ({ kind: "email-verification"; recipientName: string; expiresIn: string } & Action)
  | ({ kind: "device-offline"; deviceName: string; observedAt: string } & Action)
  | ({ kind: "device-recovered"; deviceName: string; recoveredAt: string; outageDuration: string } & Action)
  | ({ kind: "test"; recipientName: string } & Action);

export interface RenderedEmail { subject: string; html: string; text: string }
export interface RenderOptions { preview?: boolean }

const controlChars = /[\r\n\u0000-\u001f\u007f]+/g;
const cleanSubject = (value: string) => value.replace(controlChars, " ").replace(/\s+/g, " ").trim().slice(0, 180);

function trustedAction(actionUrl: string, publicUrl: URL): URL {
  const action = new URL(actionUrl, publicUrl);
  if (action.origin !== publicUrl.origin || !["https:", "http:"].includes(action.protocol) || action.username || action.password) {
    throw new Error("untrusted-action-url");
  }
  return action;
}

function Layout({ title, preheader, badge, children, action, actionLabel, preview = false, preferences }: React.PropsWithChildren<{ title: string; preheader: string; badge?: string; action: URL; actionLabel: string; preview?: boolean; preferences?: URL }>) {
  return <html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body style={{ margin: 0, background: "#f3f6fb", fontFamily: "Arial, sans-serif", color: "#17233c" }}>
    <div style={{ display: "none", maxHeight: 0, overflow: "hidden" }}>{preheader}</div>
    <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" style={{ background: "#f3f6fb", width: "100%" }}><tbody><tr><td align="center" style={{ padding: "28px 12px" }}>
      <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" style={{ maxWidth: 600, background: "#ffffff", borderRadius: 12, border: "1px solid #dfe6f2" }}><tbody>
        <tr><td style={{ padding: "25px 32px", background: "#14213d", color: "#ffffff", borderRadius: "12px 12px 0 0", fontSize: 22, fontWeight: 700 }}>Device<span style={{ color: "#63d7c6" }}>Yard</span></td></tr>
        <tr><td style={{ padding: "32px" }}>{badge && <div style={{ display: "inline-block", padding: "6px 10px", borderRadius: 999, background: "#e8f4f2", color: "#176b61", fontSize: 12, fontWeight: 700 }}>{badge}</div>}<h1 style={{ fontSize: 26, lineHeight: "34px", margin: "16px 0" }}>{title}</h1>{children}
          {preview ? <span style={{ display: "inline-block", padding: "13px 20px", background: "#bcc7d8", color: "#ffffff", borderRadius: 7, fontWeight: 700 }}>{actionLabel}</span> : <a href={action.toString()} style={{ display: "inline-block", padding: "13px 20px", background: "#2364d2", color: "#ffffff", borderRadius: 7, textDecoration: "none", fontWeight: 700 }}>{actionLabel}</a>}
        </td></tr>
        <tr><td style={{ padding: "20px 32px", borderTop: "1px solid #e5eaf2", color: "#68758c", fontSize: 12 }}>DeviceYard · Reliable mobile testing{preferences && <> · {preview ? "Manage notification preferences in DeviceYard." : <a href={preferences.toString()} style={{ color: "#49617f" }}>Manage notification preferences</a>}</>}</td></tr>
      </tbody></table>
    </td></tr></tbody></table>
  </body></html>;
}

const P = ({ children }: React.PropsWithChildren) => <p style={{ fontSize: 16, lineHeight: "25px", margin: "0 0 20px" }}>{children}</p>;

export function renderEmail(data: EmailData, publicUrl: string | URL, options: RenderOptions = {}): RenderedEmail {
  const base = publicUrl instanceof URL ? publicUrl : new URL(publicUrl);
  const action = trustedAction(data.actionUrl, base);
  const preferences = new URL("/notifications", base);
  let subject: string;
  let text: string;
  let body: React.ReactElement;
  switch (data.kind) {
    case "run-result": { const failed = data.failedFlowNames.slice(0, 5); const extra = Math.max(0, data.failedFlowNames.length - failed.length); subject = `${data.result === "passed" ? "Passed" : "Failed"}: ${data.organisationName} run ${data.jobId}`; text = `${subject}\n\nDuration: ${data.duration}\nPassed flows: ${data.passedFlows}\nFailed flows: ${data.failedFlows}${failed.length ? `\nFailed: ${failed.join(", ")}${extra ? ` (+${extra} more)` : ""}` : ""}\n\nView run: ${action}\nManage notification preferences: ${preferences}`; body = <Layout title={`Run ${data.result}`} preheader={subject} badge={data.result === "passed" ? "✓ PASSED" : "! FAILED"} action={action} actionLabel="View run" preview={options.preview} preferences={preferences}><P>Hello {data.recipientName}, the run for <strong>{data.organisationName}</strong> has {data.result}.</P><table role="presentation" width="100%" style={{ marginBottom: 22, background: "#f7f9fc" }}><tbody><tr><td style={{ padding: 14 }}>Duration<br/><strong>{data.duration}</strong></td><td style={{ padding: 14 }}>Passed<br/><strong>{data.passedFlows}</strong></td><td style={{ padding: 14 }}>Failed<br/><strong>{data.failedFlows}</strong></td></tr></tbody></table>{failed.length > 0 && <P>Failed flows: <strong>{failed.join(", ")}</strong>{extra > 0 && ` and ${extra} more`}.</P>}</Layout>; break; }
    case "invitation": subject = `You're invited to ${data.organisationName} on DeviceYard`; text = `${subject}\n\n${data.inviterName} invited you. This invitation expires in ${data.expiresIn}.\n\nAccept invitation: ${action}`; body = <Layout title="Join your team on DeviceYard" preheader={subject} action={action} actionLabel="Accept invitation" preview={options.preview}><P>Hello {data.recipientName}, <strong>{data.inviterName}</strong> invited you to <strong>{data.organisationName}</strong>.</P><P>This invitation expires in {data.expiresIn}.</P></Layout>; break;
    case "password-reset": subject = "Reset your DeviceYard password"; text = `${subject}\n\nThis link expires in ${data.expiresIn}. If you did not request this, you can ignore this email.\n\nReset password: ${action}`; body = <Layout title="Reset your password" preheader={subject} action={action} actionLabel="Reset password" preview={options.preview}><P>Hello {data.recipientName}, use the button below within {data.expiresIn}.</P><P>If you did not request a reset, you can safely ignore this email.</P></Layout>; break;
    case "email-verification": subject = "Verify your DeviceYard email"; text = `${subject}\n\nThis link expires in ${data.expiresIn}.\n\nVerify email: ${action}`; body = <Layout title="Verify your email" preheader={subject} action={action} actionLabel="Verify email" preview={options.preview}><P>Hello {data.recipientName}, confirm this email address to enable notifications. The link expires in {data.expiresIn}.</P></Layout>; break;
    case "device-offline": subject = `Device offline: ${data.deviceName}`; text = `${subject}\n\nOffline since ${data.observedAt}.\n\nView device: ${action}\nManage notification preferences: ${preferences}`; body = <Layout title="A device is offline" preheader={subject} badge="! OFFLINE" action={action} actionLabel="View device" preview={options.preview} preferences={preferences}><P><strong>{data.deviceName}</strong> has remained offline since {data.observedAt}.</P></Layout>; break;
    case "device-recovered": subject = `Device recovered: ${data.deviceName}`; text = `${subject}\n\nRecovered at ${data.recoveredAt} after ${data.outageDuration}.\n\nView device: ${action}\nManage notification preferences: ${preferences}`; body = <Layout title="Device recovered" preheader={subject} badge="✓ RECOVERED" action={action} actionLabel="View device" preview={options.preview} preferences={preferences}><P><strong>{data.deviceName}</strong> recovered at {data.recoveredAt} after {data.outageDuration} offline.</P></Layout>; break;
    case "test": subject = "DeviceYard test email"; text = `${subject}\n\nHello ${data.recipientName}. Your SMTP configuration can send HTML and plain-text email.\n\nOpen DeviceYard: ${action}`; body = <Layout title="Your email setup works" preheader={subject} badge="✓ TEST" action={action} actionLabel="Open DeviceYard" preview={options.preview}><P>Hello {data.recipientName}, DeviceYard successfully rendered this SMTP test message.</P></Layout>; break;
  }
  return { subject: cleanSubject(subject), html: "<!doctype html>" + renderToStaticMarkup(body), text };
}

export function sampleEmail(kind: TemplateKind): EmailData {
  const actionUrl = "/preview/example";
  switch (kind) {
    case "run-result": return { kind, recipientName: "Alex", organisationName: "Example Mobile Team", jobId: "run-example-42", result: "failed", duration: "4m 18s", passedFlows: 12, failedFlows: 2, failedFlowNames: ["Checkout flow", "Account recovery"], actionUrl };
    case "invitation": return { kind, recipientName: "Alex", organisationName: "Example Mobile Team", inviterName: "Morgan", expiresIn: "7 days", actionUrl };
    case "password-reset": return { kind, recipientName: "Alex", expiresIn: "30 minutes", actionUrl };
    case "email-verification": return { kind, recipientName: "Alex", expiresIn: "24 hours", actionUrl };
    case "device-offline": return { kind, deviceName: "Pixel Lab 03", observedAt: "10:42 UTC", actionUrl };
    case "device-recovered": return { kind, deviceName: "Pixel Lab 03", recoveredAt: "10:49 UTC", outageDuration: "7 minutes", actionUrl };
    case "test": return { kind, recipientName: "DeviceYard administrator", actionUrl };
  }
}
