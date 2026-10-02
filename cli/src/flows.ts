import fs from "fs";
import path from "path";
import { CliError } from "./exit";

export interface ResolvedFlows {
  e2eRoot: string;
  flowIds: string[];
}

/** src/jobRunner.ts resolves every flow as
 * `<extractDir>/e2e/scenarios/<name>.yaml`, so the archive layout is fixed
 * server-side while `dcd cloud` accepts any directory.
 *
 * Rather than relocate files into a synthetic layout - which would silently
 * break the relative references between flows that docs/guide/running-flows.md
 * promises keep working - the CLI finds the real e2e/ root and ships it whole.
 *
 * Relaxing the server to accept an arbitrary archive root is tracked in
 * docs/open_issues.md under "CLI (cycle 9)". */
export function findE2eRoot(target: string): string {
  let dir = path.resolve(target);
  // A path that does not exist yet is still walked: resolveFlows reports
  // "no such path" with a better message than this function could.
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);

  for (let cur = dir; ; cur = path.dirname(cur)) {
    if (path.basename(cur) === "e2e" && fs.existsSync(path.join(cur, "scenarios"))) return cur;
    if (path.dirname(cur) === cur) break;
  }

  throw new CliError(
    `could not find an e2e/scenarios directory above ${path.resolve(target)}.\n` +
    `This farm expects an e2e/scenarios directory: a flow at e2e/scenarios/map/filter.yaml ` +
    `is the flow "map/filter". Point the flows argument at that tree, or at one .yaml file ` +
    `inside it.`,
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // .yaml only: jobRunner appends ".yaml" and nothing else, so a .yml file
    // on disk would produce an id the server cannot resolve.
    else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(full);
  }
  return out;
}

export function resolveFlows(target: string, excludeFlows: string[]): ResolvedFlows {
  const e2eRoot = findE2eRoot(target);
  const scenarios = path.join(e2eRoot, "scenarios");
  const resolved = path.resolve(target);

  if (!fs.existsSync(resolved)) throw new CliError(`no such path: ${resolved}`);

  const files = fs.statSync(resolved).isFile() ? [resolved] : walk(resolved);
  const toId = (file: string): string =>
    path.relative(scenarios, file).replace(/\.yaml$/, "").split(path.sep).join("/");

  const excluded = new Set(excludeFlows.map((e) => e.replace(/\.yaml$/, "")));
  const flowIds = files
    .map(toId)
    // An id starting with ".." escaped e2e/scenarios - a sibling like
    // e2e/shared/, picked up when the target was e2e/ itself. Those files
    // belong in the archive but are not flows.
    .filter((id) => !id.startsWith(".."))
    .filter((id) => !excluded.has(id) && ![...excluded].some((e) => id.startsWith(`${e}/`)))
    // Sorted rather than left in filesystem order: readdirSync order is not
    // stable across platforms, and POST /run runs flows IN THE ORDER GIVEN -
    // so an unsorted list would make run order depend on which machine
    // invoked the CLI.
    .sort();

  if (flowIds.length === 0) {
    throw new CliError(
      `no flows left to run under ${resolved}` +
      (excludeFlows.length
        ? ` after applying --exclude-flows`
        : ` (looked for *.yaml files under ${scenarios})`),
    );
  }

  return { e2eRoot, flowIds };
}

/** Maestro flow files are two YAML documents separated by `---`: a header
 * carrying appId/tags/env, then the step list. Only the header is read here,
 * and only enough of it to find `tags:` - pulling in a YAML parser to answer
 * one question would add a dependency to a bundle whose whole point is not
 * having any. A step body mentioning "tags:" cannot be misread, because
 * scanning stops at the separator. */
export function readFlowTags(e2eRoot: string, flowId: string): string[] {
  const file = path.join(e2eRoot, "scenarios", `${flowId}.yaml`);
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const tags: string[] = [];
  let inBlock = false;

  const unquote = (value: string): string => value.trim().replace(/^["']|["']$/g, "");

  for (const line of lines) {
    if (line.trim() === "---") break;

    const flowSeq = /^tags:\s*\[(.*)\]\s*$/.exec(line);
    if (flowSeq) return flowSeq[1].split(",").map(unquote).filter(Boolean);

    if (/^tags:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        tags.push(unquote(item[1]));
        continue;
      }
      inBlock = false;
    }
  }
  return tags;
}

/** Runs entirely client-side: the CLI already walks these files to build the
 * flows array, so honouring --include-tags/--exclude-tags costs one read per
 * flow and no server change at all. */
export function filterByTags(
  flows: ResolvedFlows,
  include: string[],
  exclude: string[],
): ResolvedFlows {
  if (include.length === 0 && exclude.length === 0) return flows;

  const kept = flows.flowIds.filter((id) => {
    const tags = readFlowTags(flows.e2eRoot, id);
    if (include.length > 0 && !include.some((t) => tags.includes(t))) return false;
    if (exclude.length > 0 && exclude.some((t) => tags.includes(t))) return false;
    return true;
  });

  if (kept.length === 0) {
    throw new CliError(
      `no flows match the given tags` +
      (include.length ? ` (--include-tags ${include.join(",")})` : "") +
      (exclude.length ? ` (--exclude-tags ${exclude.join(",")})` : "") +
      `. Run with --dry-run to see the flows and tags that were found.`,
    );
  }

  return { ...flows, flowIds: kept };
}
