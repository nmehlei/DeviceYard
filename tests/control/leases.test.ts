import { ControlLeases } from "../../src/control/leases";

const alice = { userId: 1, username: "alice" };
const bob = { userId: 2, username: "bob" };

test("acquire grants an unheld device and records the holder", () => {
  const leases = new ControlLeases();
  const result = leases.acquire("dev-1", alice, 1000);
  expect(result.ok).toBe(true);
  expect(leases.get("dev-1")?.holder).toEqual(alice);
  expect(leases.occupiedDeviceIds()).toEqual(["dev-1"]);
});

test("a second admin cannot take a held device, and is told who has it", () => {
  const leases = new ControlLeases();
  leases.acquire("dev-1", alice, 1000);
  expect(leases.acquire("dev-1", bob, 1001)).toEqual({ ok: false, heldBy: "alice" });
  expect(leases.get("dev-1")?.holder).toEqual(alice);
});

test("re-acquiring by the current holder refreshes rather than refusing", () => {
  const leases = new ControlLeases();
  leases.acquire("dev-1", alice, 1000);
  expect(leases.acquire("dev-1", alice, 5000).ok).toBe(true);
  expect(leases.get("dev-1")?.lastSeenAt).toBe(5000);
});

test("only the holder can release", () => {
  const leases = new ControlLeases();
  leases.acquire("dev-1", alice, 1000);
  expect(leases.release("dev-1", bob.userId)).toBe(false);
  expect(leases.get("dev-1")).toBeDefined();
  expect(leases.release("dev-1", alice.userId)).toBe(true);
  expect(leases.get("dev-1")).toBeUndefined();
  expect(leases.occupiedDeviceIds()).toEqual([]);
});

test("a lease not touched within the TTL expires", () => {
  const leases = new ControlLeases({ ttlMs: 30_000 });
  leases.acquire("dev-1", alice, 0);
  expect(leases.expired(29_999)).toEqual([]);
  expect(leases.expired(30_000)).toEqual(["dev-1"]);
});

test("touch by the holder pushes expiry out; touch by anyone else does not", () => {
  const leases = new ControlLeases({ ttlMs: 30_000 });
  leases.acquire("dev-1", alice, 0);
  leases.touch("dev-1", bob.userId, 20_000);
  expect(leases.expired(30_000)).toEqual(["dev-1"]);
  leases.touch("dev-1", alice.userId, 20_000);
  expect(leases.expired(30_000)).toEqual([]);
  expect(leases.expired(50_000)).toEqual(["dev-1"]);
});

test("beginRelease sets a deadline once and is idempotent", () => {
  const leases = new ControlLeases({ graceMs: 60_000 });
  leases.acquire("dev-1", alice, 0);
  expect(leases.beginRelease("dev-1", "job-a", 1000)).toBe(61_000);
  // A second call while counting down must not restart the clock, or a queue
  // that stays busy would postpone the release forever.
  expect(leases.beginRelease("dev-1", "job-a", 30_000)).toBe(61_000);
  expect(leases.get("dev-1")?.waitingJobId).toBe("job-a");
});

test("a lease counting down expires at the deadline even while being touched", () => {
  const leases = new ControlLeases({ ttlMs: 30_000, graceMs: 60_000 });
  leases.acquire("dev-1", alice, 0);
  leases.beginRelease("dev-1", "job-a", 0);
  leases.touch("dev-1", alice.userId, 59_000);
  expect(leases.expired(59_999)).toEqual([]);
  expect(leases.expired(60_000)).toEqual(["dev-1"]);
});

test("cancelRelease clears the countdown and the waiting job", () => {
  const leases = new ControlLeases({ ttlMs: 100_000, graceMs: 60_000 });
  leases.acquire("dev-1", alice, 0);
  leases.beginRelease("dev-1", "job-a", 0);
  expect(leases.cancelRelease("dev-1")).toBe(true);
  expect(leases.get("dev-1")?.releaseAt).toBeUndefined();
  expect(leases.get("dev-1")?.waitingJobId).toBeUndefined();
  expect(leases.expired(60_000)).toEqual([]);
});

test("beginRelease on an unheld device does nothing", () => {
  const leases = new ControlLeases();
  expect(leases.beginRelease("ghost", "job-a", 0)).toBeUndefined();
});
