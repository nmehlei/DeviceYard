import type { CommandRunner } from "../src/maestro";
import {
  parseUsers,
  isFarmProfile,
  farmProfileName,
  removeFarmProfiles,
  probeIsolationCapability,
  cleanUpFarmProfilesAtStartup,
} from "../src/workProfiles";

const USERS = [
  "Users:",
  "\tUserInfo{0:Owner:c13} running",
  "\tUserInfo{150:Secure Folder:10001030}",
  "\tUserInfo{17:deviceyard-abc:1030}",
].join("\n");
// Secure Folder's flags (0x...30) include the managed-profile bit, so a device
// with it is correctly NOT capable; capable cases use a plain owner-only device.
const OWNER_ONLY = "Users:\n\tUserInfo{0:Owner:c13} running\n";
const FEATURES = "feature:android.hardware.usb.host\nfeature:android.software.managed_users\n";

function fakeAdb(opts: {
  users?: string;
  features?: string;
  usersFail?: boolean;
  featuresFail?: boolean;
  removeFail?: number[];
}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args);
    const rest = args.slice(2).join(" ");
    if (rest === "shell pm list users") {
      if (opts.usersFail) throw new Error("adb timed out");
      return { code: 0, stdout: opts.users ?? USERS, stderr: "" };
    }
    if (rest === "shell pm list features") {
      if (opts.featuresFail) return { code: 1, stdout: "", stderr: "error" };
      return { code: 0, stdout: opts.features ?? FEATURES, stderr: "" };
    }
    const m = /^shell pm remove-user (\d+)$/.exec(rest);
    if (m) {
      return opts.removeFail?.includes(Number(m[1]))
        ? { code: 1, stdout: "", stderr: "Error: could not remove" }
        : { code: 0, stdout: "Success: removed user", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

const removals = (calls: string[][]) => calls.filter((c) => c.includes("remove-user"));

test("parseUsers reads id, name and hex flags", () =>
  expect(parseUsers(USERS)).toEqual([
    { id: 0, name: "Owner", flags: 0xc13 },
    { id: 150, name: "Secure Folder", flags: 0x10001030 },
    { id: 17, name: "deviceyard-abc", flags: 0x1030 },
  ]));

test("isFarmProfile never matches user 0, even if named like a farm profile", () => {
  expect(isFarmProfile({ id: 0, name: "deviceyard-x", flags: 0 })).toBe(false);
  expect(isFarmProfile({ id: 5, name: "deviceyard-x", flags: 0 })).toBe(true);
  expect(farmProfileName("abc", 2).startsWith("deviceyard-")).toBe(true);
});

test("removeFarmProfiles removes only deviceyard-* users and never user 0, Secure Folder or another profile", async () => {
  const users = USERS + "\n\tUserInfo{12:Work profile:30}\n\tUserInfo{0:deviceyard-evil:13}";
  const { runner, calls } = fakeAdb({ users });
  const result = await removeFarmProfiles("D1", runner);
  expect(result).toEqual({ removed: [17], warnings: [] });
  expect(removals(calls)).toEqual([["-s", "D1", "shell", "pm", "remove-user", "17"]]);
});

test("a failed removal is a warning, not a throw", async () => {
  const { runner } = fakeAdb({ removeFail: [17] });
  const result = await removeFarmProfiles("D1", runner);
  expect(result.removed).toEqual([]);
  expect(result.warnings).toHaveLength(1);
});

test("a failed user listing removes nothing and warns", async () => {
  const { runner, calls } = fakeAdb({ usersFail: true });
  const result = await removeFarmProfiles("D1", runner);
  expect(result.removed).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(removals(calls)).toEqual([]);
});

test("capability: managed_users plus no foreign managed profile is true", async () => {
  expect(await probeIsolationCapability("D1", fakeAdb({ users: OWNER_ONLY }).runner)).toBe(true);
  // Secure Folder carries the managed-profile flag, so it blocks isolation.
  expect(await probeIsolationCapability("D1", fakeAdb({}).runner)).toBe(false);
});

test("capability: a foreign managed profile (e.g. a corporate work profile) makes the device not capable", async () => {
  const { runner } = fakeAdb({ users: USERS + "\n\tUserInfo{12:Work profile:30}" });
  expect(await probeIsolationCapability("D1", runner)).toBe(false);
});

test("capability: a farm leftover does not make the device not capable", async () => {
  const { runner } = fakeAdb({ users: OWNER_ONLY + "\tUserInfo{18:deviceyard-old:30}" });
  expect(await probeIsolationCapability("D1", runner)).toBe(true);
});

test("capability: no managed_users feature is false; an adb failure is null", async () => {
  expect(await probeIsolationCapability("D1", fakeAdb({ features: "feature:android.hardware.usb.host\n" }).runner)).toBe(false);
  expect(await probeIsolationCapability("D1", fakeAdb({ featuresFail: true }).runner)).toBeNull();
  expect(await probeIsolationCapability("D1", fakeAdb({ usersFail: true }).runner)).toBeNull();
});

test("startup cleanup covers every registered device, records capability, and survives one device failing", async () => {
  const calls: string[][] = [];
  const inner = fakeAdb({ users: OWNER_ONLY + "\tUserInfo{17:deviceyard-abc:1030}" }).runner;
  const runner: CommandRunner = async (file, args) => {
    calls.push(args);
    if (args[1] === "BAD") throw new Error("boom");
    return inner(file, args);
  };
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const stored = new Map<string, boolean | null>();
  const devices = {
    list: () => [{ id: "BAD" }, { id: "GOOD" }],
    setIsolationCapable: (id: string, v: boolean | null) => void stored.set(id, v),
  } as never;
  await expect(cleanUpFarmProfilesAtStartup(devices, runner)).resolves.toBeUndefined();
  expect(stored.get("GOOD")).toBe(true);
  logSpy.mockRestore();
  expect(removals(calls).map((c) => c.join(" "))).toEqual(["-s GOOD shell pm remove-user 17"]);
});

test("parseUsers only accepts lines that are a UserInfo entry", () => {
  const out = USERS + "\n  note: see UserInfo{10:deviceyard-x:0} in log\n\tUserInfo{11:a UserInfo{10:deviceyard-y:0}:10}";
  expect(parseUsers(out).map((u) => u.id)).toEqual([0, 150, 17]);
});

test("a busy device gets no remove-user call but still has its capability stored", async () => {
  const { runner, calls } = fakeAdb({ users: OWNER_ONLY + "\tUserInfo{17:deviceyard-abc:1030}" });
  const stored = new Map<string, boolean | null>();
  const devices = {
    list: () => [{ id: "D1" }],
    setIsolationCapable: (id: string, v: boolean | null) => void stored.set(id, v),
  } as never;
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  await cleanUpFarmProfilesAtStartup(devices, runner, (id) => id === "D1");
  logSpy.mockRestore();
  expect(removals(calls)).toEqual([]);
  expect(stored.get("D1")).toBe(true);
});

test("startup cleanup does not overwrite a stored capability with unknown", async () => {
  const { runner } = fakeAdb({ usersFail: true });
  const set = jest.fn();
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  await cleanUpFarmProfilesAtStartup({ list: () => [{ id: "D1" }], setIsolationCapable: set } as never, runner);
  logSpy.mockRestore();
  expect(set).not.toHaveBeenCalled();
});
