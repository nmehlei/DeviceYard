import type { StepRow } from "../../../shared/apiTypes";

/** `&` must come first: escaping it after `<`/`>`/etc. would re-escape the
 * ampersands those substitutions just introduced. Same ordering as
 * src/env.ts's xmlEscape, for the same reason. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Synthesised entirely client-side from GET /api/jobs/:id, so the farm needs
 * no reporting subsystem to offer --report junit.
 *
 * Setup steps are excluded deliberately: a JUnit consumer treats every
 * testcase as a test, so an "<install>" failure would surface as a
 * mysteriously named failing test rather than as the infrastructure problem
 * it is. The run's exit code already carries that distinction. */
export function renderJUnit(jobId: string, steps: StepRow[]): string {
  const flows = steps.filter((s) => s.kind === "flow");
  const failures = flows.filter((s) => s.status === "failed").length;
  const skipped = flows.filter((s) => s.status === "skipped").length;

  const seconds = (s: StepRow): string =>
    s.startedAt !== null && s.finishedAt !== null
      ? String((s.finishedAt - s.startedAt) / 1000)
      : "0";

  const cases = flows.map((s) => {
    const open = `    <testcase name="${esc(s.name)}" classname="deviceyard" time="${seconds(s)}">`;
    if (s.status === "failed") {
      const detail = esc((s.stderrPreview || s.stdoutPreview || "flow failed").slice(0, 4000));
      return `${open}\n      <failure message="flow failed">${detail}</failure>\n    </testcase>`;
    }
    if (s.status === "skipped") return `${open}\n      <skipped/>\n    </testcase>`;
    return `${open}</testcase>`;
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="${esc(jobId)}" tests="${flows.length}" failures="${failures}" skipped="${skipped}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join("\n");
}
