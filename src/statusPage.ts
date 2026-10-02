import type { LegacyJob } from "./store/legacyView";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRow(job: LegacyJob): string {
  const id = escapeHtml(job.id);
  const status = escapeHtml(job.status);
  const flowCount = job.flows.length;
  const flowNames = escapeHtml(job.flows.join(", "));
  const createdAt = escapeHtml(new Date(job.createdAt).toISOString());
  return `<tr><td>${id}</td><td>${status}</td><td>${flowCount}</td><td>${flowNames}</td><td>${createdAt}</td></tr>`;
}

export function renderStatusPage(jobs: LegacyJob[]): string {
  const rows =
    jobs.length > 0
      ? jobs.map(renderRow).join("\n")
      : `<tr><td colspan="5">No jobs yet</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>DeviceYard - Status</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; }
  tr:hover { background: #fafafa; }
</style>
</head>
<body>
<h1><img src="/brand/deviceyard-mark.svg" width="40" height="40" alt="" style="vertical-align:middle;margin-right:12px">DeviceYard - Status</h1>
<table>
<thead>
<tr><th>id</th><th>status</th><th>flow count</th><th>flows</th><th>created</th></tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
