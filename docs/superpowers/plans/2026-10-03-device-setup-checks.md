# Device Setup Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn in the DeviceYard dashboard when a device's adb authorization timeout or "Verify apps over USB" is not disabled, and let an admin fix it with one click.

**Architecture:** A registry of setup checks (`src/deviceSetupChecks.ts`) owns each check's adb read/fix argv and its ok-test. `GET /api/devices` reads every check in the one per-device adb call it already makes (the model `getprop`), and a new admin route applies a check's fix and verifies it by reading back. The dashboard renders failing checks on the device card with a Fix button for admins and a summary tile on the devices page.

**Tech Stack:** TypeScript, Express, `node:sqlite`, Jest + supertest (backend); Next.js 16 / React 19, Jest + Testing Library (dashboard).

**Spec:** `docs/superpowers/specs/2026-10-02-device-setup-checks-design.md`

## Global Constraints

- Manual fix only: the runner never changes a device setting except through the admin fix route (spec D-1).
- Exactly two checks: `adb-auth-timeout` (`adb_allowed_connection_time`) and `adb-install-verification` (`verifier_verify_adb_installs`). Never touch `package_verifier_enable`.
- A check is ok only when the trimmed value is exactly `0`. `null` is not ok. An empty or missing section is `null` (unknown), never `false`.
- No extra adb process per device per poll: the probe REPLACES the `getprop ro.product.model` call.
- A fix returns 200 only after the read-back passes `isOk`.
- Fix route is admin-only (403), wrapped in `hardware()`, records device event kind `setup_fix`.
- Commits: conventional style, **no** `Co-Authored-By` or other AI attribution lines.
- Work on branch `feat/device-setup-checks`; never commit to `main`.

## Review Focus

1. **A flaky probe must not raise a warning.** Probe throws, times out, or prints no markers -> every check `ok: null`, list still 200. Pinned in Task 2.
2. **Old fake runners / older adb output without markers** -> model still parsed, checks `null`. Pinned in Task 1 (`parseProbeOutput` with model-only output) and implicitly by the existing `tests/api/devices.test.ts` suite staying green.
3. **Fix that "succeeds" but does not stick** (Play services resetting the value, a vendor ROM ignoring the write) -> 502, no event. Pinned in Task 3; that test must fail if the read-back step is deleted.
4. **Two checks failing at once** -> two warnings, two independently labelled Fix buttons, each calling its own check id. Pinned in Task 4.
5. **A device that is `unauthorized`/`offline`** -> no warning (unknown), and the fix route refuses with 409 instead of running adb against it. Pinned in Tasks 2 and 3.

---

### Task 1: Setup-check registry, probe builder and parser

**Files:**
- Create: `src/deviceSetupChecks.ts`
- Test: `tests/deviceSetupChecks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DeviceSetupCheck { id: string; title: string; detail: string; readArgs: readonly string[]; isOk(output: string): boolean; fixArgs: readonly string[] }`
  - `interface SetupCheckResult { id: string; title: string; detail: string; ok: boolean | null }`
  - `const SETUP_CHECKS: readonly DeviceSetupCheck[]`
  - `function findSetupCheck(id: string): DeviceSetupCheck | undefined`
  - `function buildProbeArgs(checks?: readonly DeviceSetupCheck[]): string[]` - argv to append after `["-s", id, "shell"]`
  - `function parseProbeOutput(stdout: string, checks?: readonly DeviceSetupCheck[]): { model?: string; checks: SetupCheckResult[] }`
  - `function unknownSetupChecks(checks?: readonly DeviceSetupCheck[]): SetupCheckResult[]`
  - `function checkResult(check: DeviceSetupCheck, ok: boolean | null): SetupCheckResult`

- [ ] **Step 1: Write the failing tests**

`tests/deviceSetupChecks.test.ts`:

```ts
import {
  SETUP_CHECKS,
  buildProbeArgs,
  findSetupCheck,
  parseProbeOutput,
  unknownSetupChecks,
} from "../src/deviceSetupChecks";

// Captured from the farm's Galaxy S10 on 2026-10-03 with both settings fixed.
const REAL_OK_OUTPUT =
  "SM-G973F\n__DY_CHECK_adb-auth-timeout__\n0\n__DY_CHECK_adb-install-verification__\n0\n";

const byId = (results: { id: string; ok: boolean | null }[]) =>
  Object.fromEntries(results.map((r) => [r.id, r.ok]));

test("registers exactly the two checks the spec names", () => {
  expect(SETUP_CHECKS.map((c) => c.id)).toEqual(["adb-auth-timeout", "adb-install-verification"]);
});

test("never touches Play Protect as a whole", () => {
  const everyArg = SETUP_CHECKS.flatMap((c) => [...c.readArgs, ...c.fixArgs]);
  expect(everyArg).not.toContain("package_verifier_enable");
});

test("the probe reads the model first, then each check behind its marker, as separate argv tokens", () => {
  expect(buildProbeArgs()).toEqual([
    "getprop", "ro.product.model",
    ";", "echo", "__DY_CHECK_adb-auth-timeout__",
    ";", "settings", "get", "global", "adb_allowed_connection_time",
    ";", "echo", "__DY_CHECK_adb-install-verification__",
    ";", "settings", "get", "global", "verifier_verify_adb_installs",
  ]);
});

test("real device output with both settings fixed parses as ok", () => {
  const parsed = parseProbeOutput(REAL_OK_OUTPUT);
  expect(parsed.model).toBe("SM-G973F");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": true, "adb-install-verification": true });
});

test("an unset setting reads as the literal null and is NOT ok", () => {
  const parsed = parseProbeOutput(
    "SM-G973F\n__DY_CHECK_adb-auth-timeout__\nnull\n__DY_CHECK_adb-install-verification__\nnull\n"
  );
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": false, "adb-install-verification": false });
});

test("the 7-day default timeout written out explicitly is not ok", () => {
  const parsed = parseProbeOutput("X\n__DY_CHECK_adb-auth-timeout__\n604800000\n__DY_CHECK_adb-install-verification__\n0\n");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": false, "adb-install-verification": true });
});

test("an empty section means the read failed - unknown, never a warning", () => {
  const parsed = parseProbeOutput("X\n__DY_CHECK_adb-auth-timeout__\n\n__DY_CHECK_adb-install-verification__\n0\n");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": true });
});

test("output with no markers keeps the model and leaves every check unknown", () => {
  const parsed = parseProbeOutput("Pixel 7\n");
  expect(parsed.model).toBe("Pixel 7");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": null });
});

test("CRLF line endings from older adb clients parse the same", () => {
  const parsed = parseProbeOutput(REAL_OK_OUTPUT.replace(/\n/g, "\r\n"));
  expect(parsed.model).toBe("SM-G973F");
  expect(byId(parsed.checks)).toEqual({ "adb-auth-timeout": true, "adb-install-verification": true });
});

test("empty output yields no model", () => {
  expect(parseProbeOutput("").model).toBeUndefined();
});

test("results carry title and detail so the dashboard needs no copy of its own", () => {
  const [first] = unknownSetupChecks();
  expect(first).toEqual({
    id: "adb-auth-timeout",
    title: SETUP_CHECKS[0].title,
    detail: SETUP_CHECKS[0].detail,
    ok: null,
  });
});

test("findSetupCheck resolves known ids only", () => {
  expect(findSetupCheck("adb-install-verification")?.fixArgs).toEqual([
    "settings", "put", "global", "verifier_verify_adb_installs", "0",
  ]);
  expect(findSetupCheck("nope")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/deviceSetupChecks.test.ts`
Expected: FAIL - `Cannot find module '../src/deviceSetupChecks'`.

- [ ] **Step 3: Implement**

`src/deviceSetupChecks.ts`:

```ts
/**
 * Device settings DeviceYard depends on but never changes on its own (spec
 * D-1: an admin applies a fix from the dashboard, and it lands in the device
 * event log).
 *
 * Both were found on 2026-10-02 on the farm's Galaxy S10:
 *   * adb_allowed_connection_time unset = Android's 7-day expiry of an
 *     "Always allow" USB debugging grant. After a reboot the device came back
 *     `unauthorized` and needed someone in the room.
 *   * verifier_verify_adb_installs unset = Play Protect verifies every adb
 *     install, and for an unrecognised debug build that verification is
 *     suspected of blocking on an on-screen prompt until the job times out.
 *
 * See docs/superpowers/specs/2026-10-02-device-setup-checks-design.md.
 */

export interface DeviceSetupCheck {
  /** Stable and URL-safe: it is a path segment of the fix route. */
  id: string;
  title: string;
  /** One sentence: what goes wrong if this is not fixed. */
  detail: string;
  /** `adb shell` argv that prints the current value. */
  readArgs: readonly string[];
  isOk(output: string): boolean;
  /** `adb shell` argv that applies the fix. */
  fixArgs: readonly string[];
}

export interface SetupCheckResult {
  id: string;
  title: string;
  detail: string;
  /** null = could not be read (device not online, read failed). Never a warning. */
  ok: boolean | null;
}

// `settings get` prints the literal "null" for an unset value, which here
// means the Android default - exactly the behaviour these checks exist to
// turn off. Only an explicit 0 is ok.
const isZero = (output: string) => output.trim() === "0";

export const SETUP_CHECKS: readonly DeviceSetupCheck[] = [
  {
    id: "adb-auth-timeout",
    title: "USB debugging approval expires",
    detail:
      "The device forgets this host's USB debugging approval after 7 days; after a reboot someone must accept the prompt on the device again.",
    readArgs: ["settings", "get", "global", "adb_allowed_connection_time"],
    isOk: isZero,
    fixArgs: ["settings", "put", "global", "adb_allowed_connection_time", "0"],
  },
  {
    // Deliberately the narrow "Verify apps over USB" switch, not Play Protect
    // as a whole (package_verifier_enable): only installs pushed by the farm
    // host skip the check.
    id: "adb-install-verification",
    title: "Play Protect verifies adb installs",
    detail:
      "Play Protect may stop an install from this host to show a prompt on the device, hanging the job until it times out.",
    readArgs: ["settings", "get", "global", "verifier_verify_adb_installs"],
    isOk: isZero,
    fixArgs: ["settings", "put", "global", "verifier_verify_adb_installs", "0"],
  },
];

const MARKER = /^__DY_CHECK_(.+)__$/;
const markerFor = (id: string) => `__DY_CHECK_${id}__`;

export function findSetupCheck(id: string): DeviceSetupCheck | undefined {
  return SETUP_CHECKS.find((check) => check.id === id);
}

export function checkResult(check: DeviceSetupCheck, ok: boolean | null): SetupCheckResult {
  return { id: check.id, title: check.title, detail: check.detail, ok };
}

export function unknownSetupChecks(checks: readonly DeviceSetupCheck[] = SETUP_CHECKS): SetupCheckResult[] {
  return checks.map((check) => checkResult(check, null));
}

/**
 * One `adb shell` invocation that prints the model and then every check's
 * value behind a marker line, so the device list costs one adb process per
 * device - the same as the getprop call it replaces.
 *
 * Separate argv tokens with ";" tokens between commands: adb joins them with
 * spaces and the device shell runs the result (verified on the S10). Keeping
 * "getprop" as its own token also keeps every existing fake runner that
 * matches `args.includes("getprop")` answering with a bare model.
 */
export function buildProbeArgs(checks: readonly DeviceSetupCheck[] = SETUP_CHECKS): string[] {
  const args = ["getprop", "ro.product.model"];
  for (const check of checks) args.push(";", "echo", markerFor(check.id), ";", ...check.readArgs);
  return args;
}

export function parseProbeOutput(
  stdout: string,
  checks: readonly DeviceSetupCheck[] = SETUP_CHECKS
): { model?: string; checks: SetupCheckResult[] } {
  const modelLines: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] = modelLines;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const marker = MARKER.exec(line);
    if (marker) {
      current = [];
      sections.set(marker[1], current);
      continue;
    }
    current.push(line);
  }

  const model = modelLines.find((line) => line.length > 0);
  return {
    model,
    checks: checks.map((check) => {
      const value = sections.get(check.id)?.join("\n").trim();
      // Missing marker or empty section: the read failed, not the setting.
      if (!value) return checkResult(check, null);
      return checkResult(check, check.isOk(value));
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/deviceSetupChecks.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/deviceSetupChecks.ts tests/deviceSetupChecks.test.ts
git commit -m "feat(devices): setup-check registry with one-call probe and parser"
```

---

### Task 2: `GET /api/devices` carries `setupChecks`

**Files:**
- Modify: `src/api/devices.ts` (the `GET /api/devices` handler, currently the `getprop` block around lines 139-150 and the returned object around line 162)
- Modify: `shared/apiTypes.ts:71-80` (`DeviceEntry`)
- Modify: `src/openapi/document.ts:118-122` (`Device` schema)
- Test: `tests/api/devices.setupChecks.test.ts` (new)

**Interfaces:**
- Consumes (Task 1): `buildProbeArgs`, `parseProbeOutput`, `unknownSetupChecks`, `SetupCheckResult`.
- Produces: every entry of `GET /api/devices` `devices[]` has `setupChecks: SetupCheckResult[]` (always one entry per registered check). Also a module-local helper `parseAdbDevices(stdout: string): Map<string, string>` in `src/api/devices.ts`, used again in Task 3.

- [ ] **Step 1: Write the failing tests**

`tests/api/devices.setupChecks.test.ts`:

```ts
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { deviceRoutes } from "../../src/api/devices";
import type { CommandRunner } from "../../src/maestro";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";

const DEVICE_ID = "RF8M40H8RFP";

let dir: string;
let db: Db;
let repo: JobRepository;
let deviceRepo: DeviceRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-setup-checks-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
  deviceRepo = new DeviceRepository(db);
  deviceRepo.add(DEVICE_ID, "S10");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Call = string[];

/** A device in `state`, answering the probe with `probeStdout`, recording every adb call. */
function fakeAdb(opts: {
  state?: string;
  probeStdout?: string;
  probeThrows?: boolean;
  fix?: { code: number; stderr?: string };
  readBack?: string;
}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "devices") {
      const line = opts.state ? `${DEVICE_ID}\t${opts.state}\n` : "";
      return { code: 0, stdout: `List of devices attached\n${line}`, stderr: "" };
    }
    if (args.includes("getprop")) {
      if (opts.probeThrows) throw new Error("adb timed out");
      return { code: 0, stdout: opts.probeStdout ?? "", stderr: "" };
    }
    if (args.includes("put")) {
      return { code: opts.fix?.code ?? 0, stdout: "", stderr: opts.fix?.stderr ?? "" };
    }
    if (args.includes("get")) return { code: 0, stdout: `${opts.readBack ?? "0"}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function app(runner: CommandRunner, isAdmin = true): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.org = "donable";
    req.isAdmin = isAdmin;
    next();
  });
  a.use(deviceRoutes({ repo, deviceRepo, runner }));
  return a;
}

const okById = (body: { devices: { setupChecks: { id: string; ok: boolean | null }[] }[] }) =>
  Object.fromEntries(body.devices[0].setupChecks.map((c) => [c.id, c.ok]));

describe("GET /api/devices setupChecks", () => {
  test("an online device reports each check from the probe", async () => {
    const { runner } = fakeAdb({
      state: "device",
      probeStdout: "SM-G973F\n__DY_CHECK_adb-auth-timeout__\nnull\n__DY_CHECK_adb-install-verification__\n0\n",
    });
    const res = await request(app(runner)).get("/api/devices");

    expect(res.status).toBe(200);
    expect(okById(res.body)).toEqual({ "adb-auth-timeout": false, "adb-install-verification": true });
    expect(res.body.devices[0].setupChecks[0].title).toBe("USB debugging approval expires");
    expect(res.body.devices[0].model).toBe("SM-G973F");
  });

  test("the probe replaces the model getprop - still exactly one shell call per device", async () => {
    const { runner, calls } = fakeAdb({ state: "device", probeStdout: "SM-G973F\n" });
    await request(app(runner)).get("/api/devices");

    const shellCalls = calls.filter((c) => c.includes("shell"));
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]).toEqual(expect.arrayContaining(["verifier_verify_adb_installs", "adb_allowed_connection_time"]));
  });

  test("an unauthorized device is unknown, not a warning, and is not probed", async () => {
    const { runner, calls } = fakeAdb({ state: "unauthorized" });
    const res = await request(app(runner)).get("/api/devices");

    expect(okById(res.body)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": null });
    expect(calls.some((c) => c.includes("shell"))).toBe(false);
  });

  test("a probe that throws leaves the list at 200 with every check unknown", async () => {
    const { runner } = fakeAdb({ state: "device", probeThrows: true });
    const res = await request(app(runner)).get("/api/devices");

    expect(res.status).toBe(200);
    expect(okById(res.body)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/devices.setupChecks.test.ts`
Expected: FAIL - `setupChecks` is undefined (TypeError reading `.map` of undefined / `[0]` of undefined).

- [ ] **Step 3: Implement**

In `src/api/devices.ts`:

1. Add the import next to the other local imports:

```ts
import { buildProbeArgs, parseProbeOutput, unknownSetupChecks } from "../deviceSetupChecks";
```

2. Add a module-level helper above `deviceRoutes` (it replaces the inline parse in the GET handler and is reused by Task 3):

```ts
/** `adb devices` output -> serial => state ("device", "unauthorized", ...). */
function parseAdbDevices(stdout: string): Map<string, string> {
  const stateById = new Map<string, string>();
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("List of devices attached")) continue;
    const [id, state] = line.split(/\s+/);
    if (id) stateById.set(id, state ?? "unknown");
  }
  return stateById;
}
```

3. In the `GET /api/devices` handler replace

```ts
      const liveStateById = new Map<string, string>();
      for (const line of stdout.split("\n").map((l) => l.trim())) {
        if (!line || line.startsWith("List of devices attached")) continue;
        const [id, state] = line.split(/\s+/);
        if (id) liveStateById.set(id, state ?? "unknown");
      }
```

with

```ts
      const liveStateById = parseAdbDevices(stdout);
```

4. Replace the model block

```ts
          let model = device.model;
          if (state === "device") {
            try {
              const modelResult = await runner("adb", ["-s", device.id, "shell", "getprop", "ro.product.model"]);
              const trimmed = modelResult.stdout.trim();
              if (trimmed && trimmed !== device.model) {
                model = trimmed;
                deps.deviceRepo.updateModel(device.id, trimmed);
              }
            } catch {
              // Best-effort: a failed getprop just leaves the cached model as-is.
            }
          }
```

with

```ts
          let model = device.model;
          // Unknown until read: an offline/unauthorized device cannot be
          // asked, and "could not read" must never render as a warning.
          let setupChecks = unknownSetupChecks();
          if (state === "device") {
            try {
              // One shell call for the model AND every setup check - it
              // replaces the old bare getprop, so the poll's adb cost per
              // device is unchanged.
              const probe = await runner("adb", ["-s", device.id, "shell", ...buildProbeArgs()]);
              const parsed = parseProbeOutput(probe.stdout);
              setupChecks = parsed.checks;
              if (parsed.model && parsed.model !== device.model) {
                model = parsed.model;
                deps.deviceRepo.updateModel(device.id, parsed.model);
              }
            } catch {
              // Best-effort: a failed probe leaves the cached model and
              // unknown checks.
            }
          }
```

5. Add `setupChecks,` to the returned object, after `resetPolicy: device.resetPolicy,`.

In `shared/apiTypes.ts`, add to `DeviceEntry` after `state: string;`:

```ts
  /** Device settings DeviceYard depends on. `ok: null` = could not be read
   * (device not online, or the read failed) - not a warning. */
  setupChecks?: { id: string; title: string; detail: string; ok: boolean | null }[];
```

In `src/openapi/document.ts`, add to the `Device` schema object after `resetPolicy: {...},`:

```ts
    setupChecks: array(object({
      id: { type: "string" }, title: { type: "string" }, detail: { type: "string" },
      ok: { type: ["boolean", "null"], description: "null = could not be read (device not online, or the read failed)." },
    }, ["id", "title", "detail", "ok"])),
```

- [ ] **Step 4: Run tests to verify they pass, and nothing else moved**

Run: `npx jest tests/api/devices.setupChecks.test.ts tests/api/devices.test.ts tests/api/devices.resetPolicy.test.ts tests/api/devices.rename.test.ts tests/openapi.test.ts`
Expected: PASS. The existing device tests must stay green **without edits**. Their fake runners answer `args.includes("getprop")` with a bare model, which `parseProbeOutput` reads as model-only (Review Focus 2).

- [ ] **Step 5: Commit**

```bash
git add src/api/devices.ts shared/apiTypes.ts src/openapi/document.ts tests/api/devices.setupChecks.test.ts
git commit -m "feat(devices): report setup checks on the device list from the existing adb call"
```

---

### Task 3: Fix route `POST /api/devices/:id/setup-checks/:checkId/fix`

**Files:**
- Modify: `src/api/devices.ts` (new route next to `POST /api/devices/:id/reboot`)
- Modify: `src/store/rows.ts:90-105` (`DeviceEventKind`)
- Modify: `src/openapi/document.ts` (new `add(...)` line after the reboot route, ~line 240)
- Test: `tests/api/devices.setupChecks.test.ts` (append)

**Interfaces:**
- Consumes (Task 1): `findSetupCheck`, `checkResult`. (Task 2): `parseAdbDevices`.
- Produces: route responses
  - 200 `{ check: SetupCheckResult }` with `ok: true`
  - 403 `{ error: "admin access required" }`
  - 404 `{ error: "unknown device" }` / `{ error: "unknown setup check" }`
  - 409 `{ error: "device is not connected and authorized" }`
  - 502 `{ error: "could not apply the setting: <stderr or exit N>" }` / `{ error: "setting did not take effect (read back: <value or nothing>)" }`
  - device event kind `"setup_fix"`, detail `"<title>" fixed by <actor>`

- [ ] **Step 1: Write the failing tests** (append to `tests/api/devices.setupChecks.test.ts`)

```ts
describe("POST /api/devices/:id/setup-checks/:checkId/fix", () => {
  const fix = (runner: CommandRunner, opts: { isAdmin?: boolean; device?: string; check?: string } = {}) =>
    request(app(runner, opts.isAdmin ?? true)).post(
      `/api/devices/${opts.device ?? DEVICE_ID}/setup-checks/${opts.check ?? "adb-install-verification"}/fix`
    );
  const setupFixEvents = () => deviceRepo.listEvents(DEVICE_ID).filter((e) => e.kind === "setup_fix");

  test("an admin fix applies exactly the check's write, reads it back, and records who did it", async () => {
    const { runner, calls } = fakeAdb({ state: "device", readBack: "0" });
    const res = await fix(runner);

    expect(res.status).toBe(200);
    expect(res.body.check).toEqual(expect.objectContaining({ id: "adb-install-verification", ok: true }));
    expect(calls).toContainEqual(["-s", DEVICE_ID, "shell", "settings", "put", "global", "verifier_verify_adb_installs", "0"]);
    expect(calls).toContainEqual(["-s", DEVICE_ID, "shell", "settings", "get", "global", "verifier_verify_adb_installs"]);
    const [event] = setupFixEvents();
    expect(event.detail).toBe('"Play Protect verifies adb installs" fixed by donable');
  });

  test("a write that does not stick is a 502 and is not logged as fixed", async () => {
    // Must fail if the read-back step is removed from the route.
    const { runner } = fakeAdb({ state: "device", readBack: "null" });
    const res = await fix(runner);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("setting did not take effect (read back: null)");
    expect(setupFixEvents()).toHaveLength(0);
  });

  test("a failing write is a 502 carrying adb's error, and nothing is logged", async () => {
    const { runner } = fakeAdb({ state: "device", fix: { code: 255, stderr: "Security exception: permission denied\n" } });
    const res = await fix(runner);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("could not apply the setting: Security exception: permission denied");
    expect(setupFixEvents()).toHaveLength(0);
  });

  test("non-admins cannot change device settings", async () => {
    const { runner, calls } = fakeAdb({ state: "device" });
    const res = await fix(runner, { isAdmin: false });

    expect(res.status).toBe(403);
    expect(calls.some((c) => c.includes("put"))).toBe(false);
  });

  test("an unknown device is a 404", async () => {
    const { runner } = fakeAdb({ state: "device" });
    expect((await fix(runner, { device: "nope" })).status).toBe(404);
  });

  test("an unknown check is a 404 and runs nothing on the device", async () => {
    const { runner, calls } = fakeAdb({ state: "device" });
    const res = await fix(runner, { check: "package-verifier-enable" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown setup check");
    expect(calls.some((c) => c.includes("shell"))).toBe(false);
  });

  test("a device that is not online and authorized is refused before any write", async () => {
    const { runner, calls } = fakeAdb({ state: "unauthorized" });
    const res = await fix(runner);

    expect(res.status).toBe(409);
    expect(calls.some((c) => c.includes("put"))).toBe(false);
  });

  test("each check fixes only its own setting", async () => {
    const { runner, calls } = fakeAdb({ state: "device", readBack: "0" });
    await fix(runner, { check: "adb-auth-timeout" });

    const writes = calls.filter((c) => c.includes("put"));
    expect(writes).toEqual([["-s", DEVICE_ID, "shell", "settings", "put", "global", "adb_allowed_connection_time", "0"]]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/devices.setupChecks.test.ts -t "setup-checks"`
Expected: FAIL - 404 from Express for the unmounted route on the 200/502/403/409 cases.

- [ ] **Step 3: Implement**

`src/store/rows.ts` - extend `DeviceEventKind` after `| "renamed"`:

```ts
  /** The device's display name changed. */
  | "renamed"
  /** An admin applied a setup-check fix (src/deviceSetupChecks.ts). */
  | "setup_fix";
```

(Remove the `;` that previously ended `| "renamed";`.)

`src/api/devices.ts` - extend the Task 2 import:

```ts
import { buildProbeArgs, checkResult, findSetupCheck, parseProbeOutput, unknownSetupChecks } from "../deviceSetupChecks";
```

Add the route directly after the reboot route:

```ts
  /**
   * Apply one setup check's fix (spec D-1: the only way DeviceYard changes a
   * device setting). Success means the value READ BACK as fixed - a write
   * that silently did nothing (a vendor ROM, Play services resetting it)
   * must not clear the warning.
   *
   * Allowed while a job runs: one settings write does not disturb a flow,
   * and refusing would make it unusable on a busy device.
   */
  router.post("/api/devices/:id/setup-checks/:checkId/fix", hardware(async (req, res) => {
    // Admin-only, like reset-policy: a CI token never sets req.isAdmin.
    if (!req.isAdmin) {
      res.status(403).json({ error: "admin access required" });
      return;
    }
    const device = deps.deviceRepo.get(req.params.id);
    if (!device) {
      res.status(404).json({ error: "unknown device" });
      return;
    }
    const check = findSetupCheck(req.params.checkId);
    if (!check) {
      res.status(404).json({ error: "unknown setup check" });
      return;
    }

    const { stdout } = await runner("adb", ["devices"]);
    if (parseAdbDevices(stdout).get(device.id) !== "device") {
      res.status(409).json({ error: "device is not connected and authorized" });
      return;
    }

    const write = await runner("adb", ["-s", device.id, "shell", ...check.fixArgs]);
    if (write.code !== 0) {
      res.status(502).json({ error: `could not apply the setting: ${write.stderr.trim() || `exit ${write.code}`}` });
      return;
    }

    const readBack = await runner("adb", ["-s", device.id, "shell", ...check.readArgs]);
    const value = readBack.stdout.trim();
    if (readBack.code !== 0 || !check.isOk(value)) {
      res.status(502).json({ error: `setting did not take effect (read back: ${value || "nothing"})` });
      return;
    }

    deps.deviceRepo.recordEvent(device.id, "setup_fix", `"${check.title}" fixed by ${actorOf(req, deps.userRepo)}`);
    res.status(200).json({ check: checkResult(check, true) });
  }));
```

`src/openapi/document.ts` - after the reboot `add(...)` line:

```ts
add("/api/devices/{id}/setup-checks/{checkId}/fix", OpenAPIV3_1.HttpMethods.POST, op("fixDeviceSetupCheck", "Devices", "Apply a device setup check's fix (admin)", { 200: json(object({ check: object({ id: { type: "string" }, title: { type: "string" }, detail: { type: "string" }, ok: { type: "boolean" } }, ["id", "title", "detail", "ok"]) }, ["check"])), ...errorResponses(401, 403, 404, 409, 502) }, { parameters: [pathParameter("id"), pathParameter("checkId")] }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/devices.setupChecks.test.ts tests/openapi.test.ts tests/api/devices.test.ts`
Expected: PASS. If `tests/openapi.test.ts` reports the route undocumented, the `add(...)` path string does not match `{id}`/`{checkId}` exactly.

- [ ] **Step 5: Verify the read-back test can fail**

Temporarily replace `if (readBack.code !== 0 || !check.isOk(value))` with `if (false)`, run `npx jest tests/api/devices.setupChecks.test.ts -t "does not stick"`, and confirm it FAILS. Restore the line and re-run to PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/devices.ts src/store/rows.ts src/openapi/document.ts tests/api/devices.setupChecks.test.ts
git commit -m "feat(devices): admin route to fix a setup check, verified by read-back"
```

---

### Task 4: Dashboard warning, Fix button and summary tile

**Files:**
- Modify: `dashboard/src/lib/api.ts` (`DeviceEventKind` ~line 68, `DeviceEntry` ~line 80, new `fixDeviceSetupCheck` after `rebootDevice` ~line 589)
- Modify: `dashboard/src/components/DeviceCard.tsx` (props, warning block after the `unauthorized` hint ~line 145)
- Modify: `dashboard/src/app/devices/page.tsx` (pass `admin`, summary tile)
- Test: `dashboard/tests/app/devices.test.tsx` (mock list + new `describe`)

**Interfaces:**
- Consumes: `GET /api/devices` `setupChecks` (Task 2); fix route (Task 3).
- Produces: `fixDeviceSetupCheck(id: string, checkId: string, fetchImpl?: typeof fetch): Promise<void>`; `DeviceCard` prop `admin?: boolean` (default `false`); `DeviceSetupCheckEntry` type.

- [ ] **Step 1: Write the failing tests**

In `dashboard/tests/app/devices.test.tsx`, add `fixDeviceSetupCheck: jest.fn(),` to the `jest.mock("../../src/lib/api", ...)` object. Then append:

```tsx
describe("setup checks", () => {
  const failing = (id: string, title: string) => ({ id, title, detail: `${title} detail`, ok: false });
  const NEEDS_SETUP: DeviceEntry = {
    ...ACTIVE,
    setupChecks: [
      failing("adb-auth-timeout", "USB debugging approval expires"),
      failing("adb-install-verification", "Play Protect verifies adb installs"),
    ],
  };
  const asAdmin = () =>
    (api.fetchSession as jest.Mock).mockResolvedValue({
      user: { id: 1, username: "n", email: "n@x.com", isAdmin: true },
      orgs: [],
    });

  test("a failing check is shown on the card with its explanation", async () => {
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);

    expect(await screen.findByText("USB debugging approval expires")).toBeInTheDocument();
    expect(screen.getByText("USB debugging approval expires detail")).toBeInTheDocument();
    expect(screen.getAllByText(/Required device settings/)).toHaveLength(2);
  });

  test("unknown and passing checks raise no warning", async () => {
    const quiet: DeviceEntry = {
      ...ACTIVE,
      setupChecks: [
        { id: "adb-auth-timeout", title: "USB debugging approval expires", detail: "d", ok: null },
        { id: "adb-install-verification", title: "Play Protect verifies adb installs", detail: "d", ok: true },
      ],
    };
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [quiet], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);
    await screen.findByText("Pixel 7");

    expect(screen.queryByText("USB debugging approval expires")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-setup")).not.toBeInTheDocument();
  });

  test("non-admins are told to ask an admin and get no Fix button", async () => {
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);
    await screen.findByText("USB debugging approval expires");

    expect(screen.getAllByText("Ask an admin to fix this.")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^fix:/i })).not.toBeInTheDocument();
  });

  test("an admin's Fix calls the API for that check only, then refreshes", async () => {
    asAdmin();
    (api.fixDeviceSetupCheck as jest.Mock).mockResolvedValue(undefined);
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Fix: Play Protect verifies adb installs" }));

    await waitFor(() =>
      expect(api.fixDeviceSetupCheck).toHaveBeenCalledWith("RF8M40H8RFP", "adb-install-verification")
    );
    expect(api.fixDeviceSetupCheck).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.fetchDevices).toHaveBeenCalledTimes(2));
  });

  test("a failed fix shows the server's reason", async () => {
    asAdmin();
    (api.fixDeviceSetupCheck as jest.Mock).mockRejectedValue(
      new api.ApiError(502, "setting did not take effect (read back: null)")
    );
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Fix: USB debugging approval expires" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("setting did not take effect (read back: null)");
  });

  test("the summary counts devices needing setup, not failing checks", async () => {
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP, INACTIVE], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);

    expect(await screen.findByTestId("needs-setup")).toHaveTextContent("1 device");
  });
});
```

(`ApiError` is `new ApiError(status: number, message: string)` - `dashboard/src/lib/api.ts:138`.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `dashboard/`): `npx jest tests/app/devices.test.tsx -t "setup checks"`
Expected: FAIL - warning text not found / `setupChecks` not on `DeviceEntry` (type error).

- [ ] **Step 3: Implement**

`dashboard/src/lib/api.ts`:

```ts
export type DeviceEventKind =
  | "added"
  | "activated"
  | "state_change"
  | "reboot"
  | "screenshot"
  | "reset_policy"
  | "setup_fix";
```

```ts
/** A device setting DeviceYard depends on (server: src/deviceSetupChecks.ts).
 * `ok: null` = could not be read; only `false` is a warning. */
export interface DeviceSetupCheckEntry {
  id: string;
  title: string;
  detail: string;
  ok: boolean | null;
}
```

Add to `DeviceEntry` after `resetPolicy: ResetPolicy;`:

```ts
  /** Optional so fixtures and older runners without it still type-check. */
  setupChecks?: DeviceSetupCheckEntry[];
```

After `rebootDevice`:

```ts
export async function fixDeviceSetupCheck(id: string, checkId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(
    `/api/devices/${encodeURIComponent(id)}/setup-checks/${encodeURIComponent(checkId)}/fix`,
    { method: "POST", credentials: "include" }
  );
  if (!res.ok) throw await apiErrorFrom(res, "failed to fix the device setting");
}
```

`dashboard/src/components/DeviceCard.tsx`:

- Add `fixDeviceSetupCheck,` to the `../lib/api` import.
- Change the signature to:

```tsx
export function DeviceCard({ device, onChanged, admin = false }: { device: DeviceEntry; onChanged: () => void; admin?: boolean }) {
```

- Directly after the `{device.state === "unauthorized" && ...}` line, insert:

```tsx
      {device.setupChecks?.filter((check) => check.ok === false).map((check) => (
        <div
          key={check.id}
          data-testid={`setup-check-${check.id}`}
          className="mb-4 rounded border p-3 text-xs"
          style={{ borderColor: "var(--warn-amber)" }}
        >
          <p className="font-medium" style={{ color: "var(--warn-amber)" }}>{check.title}</p>
          <p className="ops-muted mt-1">{check.detail}</p>
          <p className="ops-muted mt-1">See &ldquo;Required device settings&rdquo; in the operating guide.</p>
          {admin ? (
            <button
              className="ui-button mt-2"
              aria-label={`Fix: ${check.title}`}
              disabled={busy}
              onClick={() => void runOp(() => fixDeviceSetupCheck(device.id, check.id))}
            >
              Fix
            </button>
          ) : (
            <p className="ops-muted mt-2">Ask an admin to fix this.</p>
          )}
        </div>
      ))}
```

`dashboard/src/app/devices/page.tsx`:

- Pass `admin={admin}` to `DeviceCard`:

```tsx
<div className="ops-device-grid">{devices.map(device => <DeviceCard key={device.id} device={device} admin={admin} onChanged={refresh} />)}</div>
```

- Before `return <main ...>` add:

```tsx
  const needsSetup = devices.filter(device => device.setupChecks?.some(check => check.ok === false)).length;
```

- As the last child of `<section className="ops-stats" ...>`:

```tsx
      {needsSetup > 0 && <div data-testid="needs-setup"><p className="ops-muted ops-small">Needs setup</p><p className="ops-value" style={{color:"var(--warn-amber)"}}>{needsSetup} {needsSetup === 1 ? "device" : "devices"}</p></div>}
```

- [ ] **Step 4: Run the dashboard suite and lint**

Run (from `dashboard/`): `npx jest tests/app/devices.test.tsx && npm run lint && npx tsc --noEmit`
Expected: all PASS, no lint or type errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/api.ts dashboard/src/components/DeviceCard.tsx dashboard/src/app/devices/page.tsx dashboard/tests/app/devices.test.tsx
git commit -m "feat(dashboard): warn about device setup checks and let admins fix them"
```

---

### Task 5: Documentation and add-device instructions

**Files:**
- Modify: `docs/guide/operating.md` (new subsection after the numbered list under "## Adding a device", before "### Enable, disable, remove")
- Modify: `src/api/devices.ts` (`SETUP_INSTRUCTIONS`, ~line 36)
- Modify: `docs/guide/dashboard.md` ("## Devices")
- Modify: `docs/guide/api-reference.md` (`GET /api/devices` entry, new fix route entry after reboot)
- Test: `tests/api/devices.test.ts` (one assertion)

**Interfaces:**
- Consumes: check ids, titles and route from Tasks 1-3.
- Produces: docs only, plus one more `SETUP_INSTRUCTIONS` entry.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/devices.test.ts`:

```ts
test("the add-device instructions tell the operator to disable both expiring/blocking settings", async () => {
  const res = await request(app()).post("/api/devices").send({ id: "new-device" });

  expect(res.status).toBe(201);
  const text = res.body.setupInstructions.join("\n");
  expect(text).toMatch(/Disable adb authorization timeout/);
  expect(text).toMatch(/Verify apps over USB/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest tests/api/devices.test.ts -t "add-device instructions"`
Expected: FAIL - no match.

- [ ] **Step 3: Implement**

In `SETUP_INSTRUCTIONS`, insert after the "accept the USB debugging prompt" entry:

```ts
  'In Developer Options, turn ON "Disable adb authorization timeout" and turn OFF "Verify apps over USB" - otherwise the device forgets this host after 7 days and Play Protect can hang installs. The device card warns about both and an admin can fix them with one click.',
```

In `docs/guide/operating.md`, after step 5 / the "Registration performs no adb calls" paragraph, add:

```markdown
### Required device settings

Two Developer Options settings must be set on every farm device. The
dashboard checks both on every poll and shows a warning on the device card
when either is wrong; an admin can fix it there with **Fix** (recorded in the
device's activity log as `setup_fix`). DeviceYard never changes them on its
own.

| Check | Developer Options | adb equivalent |
|---|---|---|
| USB debugging approval expires | **Disable adb authorization timeout** - ON | `adb shell settings put global adb_allowed_connection_time 0` |
| Play Protect verifies adb installs | **Verify apps over USB** - OFF | `adb shell settings put global verifier_verify_adb_installs 0` |

**Why the authorization timeout matters.** Android 11+ drops an "Always allow
from this computer" grant once its last recorded connection is 7 days old. A
farm phone stays plugged in for weeks, so after a reboot it can come back
`unauthorized` - and recovering that needs someone in front of the device to
accept the prompt again. It cannot be done remotely without root. Seen on the
farm's S10 on 2026-10-02.

**Why adb install verification matters.** With "Verify apps over USB" on,
Play Protect checks each APK the farm installs. For a build it does not
recognise (a local debug build, for example) that check can stop on an
on-screen prompt, and the job's install step hangs until it times out. Only
installs pushed by the farm host skip the check; Play Protect itself stays
on. Google Play services may switch it back on; the warning then reappears.

The check can only read an authorized device: for an `unauthorized` or
offline device the card shows no setup warning, only the existing "accept the
USB debugging prompt" hint.
```

In `docs/guide/dashboard.md`, at the end of "## Devices" add:

```markdown
**Setup warnings.** A card shows an amber notice for each required device
setting that is wrong (see operating.md, "Required device settings"), and
the summary row adds a **Needs setup** count. Admins get a **Fix** button that
applies the setting over adb and reads it back; everyone else is told to ask
an admin. A device that cannot be read (offline, unauthorized) shows no
warning rather than a guess.
```

In `docs/guide/api-reference.md`, change the `GET /api/devices` response line to

```markdown
**`200`** — `{ devices: [{ id, label, model, isActive, state, resetPolicy, setupChecks: [{ id, title, detail, ok }] }], runnerVersion, artifactBytes }`.

`setupChecks` has one entry per required device setting; `ok` is `null` when
it could not be read (device not `device`, or the read failed), so only
`false` is a warning. The model and every check are read in one bounded
`adb shell` call per online device.
```

and add after the reboot entry:

```markdown
### `POST /api/devices/:id/setup-checks/:checkId/fix`
Admin only. Applies that check's setting over adb, then reads it back.
**`200`** — `{ check: { id, title, detail, ok: true } }`, recorded as a
`setup_fix` device event. **`403`** not an admin. **`404`** unknown device or
check. **`409`** device not connected and authorized. **`502`** the write
failed, or the read-back did not show the new value (`setting did not take
effect (read back: ...)`) - nothing is recorded.
```

- [ ] **Step 4: Run the test**

Run: `npx jest tests/api/devices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/guide/operating.md docs/guide/dashboard.md docs/guide/api-reference.md src/api/devices.ts tests/api/devices.test.ts
git commit -m "docs: required device settings, setup warnings and the fix route"
```

---

### Task 6: Full verification and PR

**Files:** none new.

- [ ] **Step 1: Reproduce CI's entry point from clean**

Run: `rm -rf dist && npm ci && npm run build && npm test`
Then (from `dashboard/`): `npm ci && npm test && npm run lint && npm run build`
Expected: everything green. If an unrelated suite flakes (known load-related flakiness in `api/admin`, `contract/ciContract`, `index`), re-run that suite alone and note it - do not change it.

- [ ] **Step 2: Whole-branch review**

Run `git diff origin/main...HEAD` and check against the spec. In particular: no auto-apply anywhere (`grep -rn "fixArgs" src` must show only the fix route), the probe replaced the old getprop (no remaining `"getprop", "ro.product.model"` call in `src/api/devices.ts` outside `buildProbeArgs`), and every new test would fail if its feature were reverted.

- [ ] **Step 3: Push and open the PR**

Push `feat/device-setup-checks`, open a PR against `main` in Azure DevOps. The description must NOT contain AI attribution. Monitor build validation until green, check the policy evaluation is not expired, then hand over with the PR URL.

- [ ] **Step 4: After merge and auto-deploy, verify on the real device**

On the farm host: confirm `/opt/mobile-device-farm/.deployed-version` shows the new version, then `curl` `GET /api/devices` with an admin session and confirm the S10 reports both checks `ok: true` (both were fixed by hand on 2026-10-02/03). Then on the host run `adb -s RF8M40H8RFP shell settings delete global verifier_verify_adb_installs`, confirm the next poll shows that check `ok: false`, press **Fix** in the dashboard, and confirm it returns to `ok: true` with a `setup_fix` event in the card's activity log.
