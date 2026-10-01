import { renderStatusPage } from "../src/statusPage";
import type { LegacyJob } from "../src/store/legacyView";

function makeJob(overrides: Partial<LegacyJob> = {}): LegacyJob {
  return {
    id: "1234-abcd",
    org: "donable",
    flows: ["map/map", "map/filter"],
    status: "done",
    results: [],
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("renders a table row per job", () => {
  const jobs = [makeJob({ id: "a" }), makeJob({ id: "b" })];
  const html = renderStatusPage(jobs);

  expect(html).toContain(">a<");
  expect(html).toContain(">b<");
  expect(html).toContain("<table");
});

test("empty-jobs case renders sensibly, not broken HTML", () => {
  const html = renderStatusPage([]);

  expect(html).toContain("<html");
  expect(html).toContain("</html>");
  expect(html).toContain("<table");
  expect(html.toLowerCase()).toContain("no jobs");
});

test("escapes HTML-special content in caller-controlled flow names", () => {
  // Flow names come straight from the caller's "flows" field on job creation
  // (see src/server.ts), unlike job.id which is always server-generated
  // (`${Date.now()}-${Math.random()...}` in src/store/jobRepository.ts) and never
  // attacker-controlled. This is the actual reachable XSS surface on the
  // status page today, so it's the field this test needs to inject through.
  const evil = '<script>alert("xss")</script>';
  const jobs = [makeJob({ flows: [evil] })];
  const html = renderStatusPage(jobs);

  expect(html).not.toContain(evil);
  expect(html).toContain("&lt;script&gt;");
});

test("shows flow count, flow names, and human-readable created time", () => {
  const jobs = [makeJob({ flows: ["a", "b", "c"], createdAt: Date.parse("2026-01-01T00:00:00.000Z") })];
  const html = renderStatusPage(jobs);

  expect(html).toContain(">3<");
  expect(html).toContain(">a, b, c<");
  expect(html).toContain("2026-01-01T00:00:00.000Z");
});

test("self-refreshes every 10 seconds via meta tag", () => {
  const html = renderStatusPage([]);
  expect(html).toContain('<meta http-equiv="refresh" content="10">');
});
