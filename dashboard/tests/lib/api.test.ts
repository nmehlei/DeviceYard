import {
  login,
  logout,
  fetchSession,
  fetchJobs,
  fetchJobDetail,
  fetchDevices,
  addDevice,
  activateDevice,
  rebootDevice,
  fetchDeviceEvents,
  changePassword,
  fetchOrgMembers,
  addOrgMember,
  removeOrgMember,
  fetchOrgTokens,
  createOrgToken,
  revokeOrgToken,
  adminListOrgs,
  adminCreateOrg,
  adminRenameOrg,
  adminArchiveOrg,
  adminListUsers,
  adminCreateUser,
  adminEditUser,
  adminDeactivateUser,
  fetchRetentionSettings,
  updateRetentionSettings,
  ApiError,
} from "../../src/lib/api";
import { getActiveOrgId, setActiveOrgId } from "../../src/lib/activeOrg";

beforeEach(() => {
  sessionStorage.clear();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

test("login posts username+password and returns user+orgs", async () => {
  const fetchImpl = mockFetch(200, {
    user: { id: 1, username: "nicolas", email: "n@example.com", isAdmin: false },
    orgs: [{ id: 5, name: "donable", archivedAt: null, createdAt: 0 }],
  });
  const result = await login("nicolas", "secret", fetchImpl);

  expect(result.user.username).toBe("nicolas");
  expect(result.orgs).toHaveLength(1);
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/session",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ username: "nicolas", password: "secret" }) })
  );
});

test("login throws ApiError on a rejected credential", async () => {
  const fetchImpl = mockFetch(403, { error: "invalid username or password" });
  await expect(login("nicolas", "wrong", fetchImpl)).rejects.toMatchObject({ status: 403 });
});

test("logout calls DELETE /api/session", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ status: 204, ok: true, json: async () => undefined });
  await logout(fetchImpl);
  expect(fetchImpl).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "DELETE" }));
});

test("logout clears the stored active org (I7)", async () => {
  setActiveOrgId(5);
  const fetchImpl = jest.fn().mockResolvedValue({ status: 204, ok: true, json: async () => undefined });
  await logout(fetchImpl);
  expect(getActiveOrgId()).toBeUndefined();
});

test("logout clears the stored active org even when the request itself fails", async () => {
  setActiveOrgId(5);
  const fetchImpl = jest.fn().mockResolvedValue({ status: 500, ok: false, json: async () => ({ error: "boom" }) });
  await expect(logout(fetchImpl)).rejects.toBeInstanceOf(ApiError);
  expect(getActiveOrgId()).toBeUndefined();
});

test("changePassword PATCHes /api/session/password with both passwords", async () => {
  const fetchImpl = mockFetch(200, { ok: true });
  await changePassword("old-pw", "new-pw-123", fetchImpl);

  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/session/password",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ currentPassword: "old-pw", newPassword: "new-pw-123" }),
    })
  );
});

test("changePassword surfaces the server's specific error message, not a generic one", async () => {
  const fetchImpl = mockFetch(403, { error: "current password is incorrect" });
  await expect(changePassword("wrong", "new-pw-123", fetchImpl)).rejects.toMatchObject({
    status: 403,
    message: "current password is incorrect",
  });
});

test("fetchSession resets a stale stored org id that isn't in the returned org list (I7)", async () => {
  setActiveOrgId(999); // stale - not in the orgs list below
  const fetchImpl = mockFetch(200, {
    user: { id: 1, username: "nicolas", email: "n@example.com", isAdmin: false },
    orgs: [{ id: 5, name: "donable", archivedAt: null, createdAt: 0 }],
  });

  await fetchSession(fetchImpl);

  expect(getActiveOrgId()).toBe(5);
});

test("fetchSession leaves a still-valid stored org id untouched", async () => {
  setActiveOrgId(5);
  const fetchImpl = mockFetch(200, {
    user: { id: 1, username: "nicolas", email: "n@example.com", isAdmin: false },
    orgs: [
      { id: 5, name: "donable", archivedAt: null, createdAt: 0 },
      { id: 6, name: "acme", archivedAt: null, createdAt: 0 },
    ],
  });

  await fetchSession(fetchImpl);

  expect(getActiveOrgId()).toBe(5);
});

test("login resets a stale stored org id that isn't in the returned org list (I7)", async () => {
  setActiveOrgId(999);
  const fetchImpl = mockFetch(200, {
    user: { id: 1, username: "nicolas", email: "n@example.com", isAdmin: false },
    orgs: [{ id: 5, name: "donable", archivedAt: null, createdAt: 0 }],
  });

  await login("nicolas", "secret", fetchImpl);

  expect(getActiveOrgId()).toBe(5);
});

test("fetchJobs returns the jobs array", async () => {
  const jobs = [{ id: "1", org: "donable", status: "done", flowCount: 3, passed: 3, failed: 0, running: 0 }];
  const fetchImpl = mockFetch(200, { jobs });
  const result = await fetchJobs(50, fetchImpl);
  expect(result).toEqual(jobs);
  expect(fetchImpl).toHaveBeenCalledWith("/api/jobs?limit=50", expect.objectContaining({ credentials: "include" }));
});

test("fetchJobDetail returns undefined on 404 instead of throwing", async () => {
  const fetchImpl = mockFetch(404, { error: "job not found" });
  const result = await fetchJobDetail("missing-id", fetchImpl);
  expect(result).toBeUndefined();
});

test("fetchJobDetail returns the job+steps payload on success", async () => {
  const payload = { job: { id: "1", status: "done" }, steps: [] };
  const fetchImpl = mockFetch(200, payload);
  const result = await fetchJobDetail("1", fetchImpl);
  expect(result).toEqual(payload);
});

test("fetchDevices returns the devices list and runner version", async () => {
  const devices = [{ id: "RF8", label: "RF8", model: "Pixel 7", isActive: true, state: "device", artifactBytes: 10 }];
  const fetchImpl = mockFetch(200, { devices, runnerVersion: "1.2.3" });
  const result = await fetchDevices(fetchImpl);
  expect(result).toEqual({ devices, runnerVersion: "1.2.3" });
});

test("fetchDevices surfaces a 502 as ApiError", async () => {
  const fetchImpl = mockFetch(502, { error: "device status unavailable" });
  await expect(fetchDevices(fetchImpl)).rejects.toBeInstanceOf(ApiError);
});

test("addDevice posts id and label and returns the created device with setup instructions", async () => {
  const device = { id: "new-device", label: "Loaner", model: null, isActive: false, state: "offline" };
  const fetchImpl = mockFetch(201, { device, setupInstructions: ["step one"] });
  const result = await addDevice("new-device", "Loaner", fetchImpl);
  expect(result).toEqual({ device, setupInstructions: ["step one"] });
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/devices",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "new-device", label: "Loaner" }) })
  );
});

test("addDevice surfaces the server's error message on a duplicate id", async () => {
  const fetchImpl = mockFetch(409, { error: "device new-device is already registered" });
  await expect(addDevice("new-device", "Loaner", fetchImpl)).rejects.toMatchObject({
    status: 409,
    message: "device new-device is already registered",
  });
});

test("activateDevice posts to the activate endpoint and returns the updated device", async () => {
  const device = { id: "d1", label: "d1", model: null, isActive: true, state: "device" };
  const fetchImpl = mockFetch(200, { device });
  const result = await activateDevice("d1", fetchImpl);
  expect(result).toEqual(device);
  expect(fetchImpl).toHaveBeenCalledWith("/api/devices/d1/activate", expect.objectContaining({ method: "POST" }));
});

test("activateDevice surfaces a 409 (job running) with the server's message", async () => {
  const fetchImpl = mockFetch(409, { error: "a job is currently running on the active device" });
  await expect(activateDevice("d1", fetchImpl)).rejects.toMatchObject({ status: 409 });
});

test("rebootDevice posts to the reboot endpoint", async () => {
  const fetchImpl = mockFetch(202, { ok: true });
  await rebootDevice("d1", fetchImpl);
  expect(fetchImpl).toHaveBeenCalledWith("/api/devices/d1/reboot", expect.objectContaining({ method: "POST" }));
});

test("fetchDeviceEvents returns the events array", async () => {
  const events = [{ id: 1, deviceId: "d1", kind: "reboot", detail: "requested by donable", createdAt: 0 }];
  const fetchImpl = mockFetch(200, { events });
  const result = await fetchDeviceEvents("d1", 10, fetchImpl);
  expect(result).toEqual(events);
  expect(fetchImpl).toHaveBeenCalledWith("/api/devices/d1/events?limit=10", expect.objectContaining({ credentials: "include" }));
});

test("fetchSession returns the current user and orgs", async () => {
  const fetchImpl = mockFetch(200, {
    user: { id: 1, username: "nicolas", email: "n@example.com", isAdmin: false },
    orgs: [],
  });
  const result = await fetchSession(fetchImpl);
  expect(result.user.username).toBe("nicolas");
});

test("fetchOrgMembers/addOrgMember/removeOrgMember hit the right org-scoped routes", async () => {
  const list = mockFetch(200, { members: [] });
  await fetchOrgMembers(5, list);
  expect(list).toHaveBeenCalledWith("/api/orgs/5/members", expect.objectContaining({ credentials: "include" }));

  const add = mockFetch(201, { ok: true });
  await addOrgMember(5, 9, add);
  expect(add).toHaveBeenCalledWith(
    "/api/orgs/5/members",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ userId: 9 }) })
  );

  const remove = mockFetch(204, undefined);
  await removeOrgMember(5, 9, remove);
  expect(remove).toHaveBeenCalledWith("/api/orgs/5/members/9", expect.objectContaining({ method: "DELETE" }));
});

test("fetchOrgTokens/createOrgToken/revokeOrgToken hit the right org-scoped routes", async () => {
  const list = mockFetch(200, { tokens: [] });
  await fetchOrgTokens(5, list);
  expect(list).toHaveBeenCalledWith("/api/orgs/5/tokens", expect.objectContaining({ credentials: "include" }));

  const create = mockFetch(201, { token: { id: 1, orgId: 5, label: "CI", value: "raw", createdAt: 0, createdByUserId: null } });
  const created = await createOrgToken(5, "CI", create);
  expect(created.value).toBe("raw");

  const revoke = mockFetch(204, undefined);
  await revokeOrgToken(5, 1, revoke);
  expect(revoke).toHaveBeenCalledWith("/api/orgs/5/tokens/1", expect.objectContaining({ method: "DELETE" }));
});

test("admin org/user functions hit /api/admin/* routes", async () => {
  const listOrgs = mockFetch(200, { orgs: [] });
  await adminListOrgs(listOrgs);
  expect(listOrgs).toHaveBeenCalledWith("/api/admin/orgs", expect.objectContaining({ credentials: "include" }));

  const createOrg = mockFetch(201, { org: { id: 1, name: "acme", archivedAt: null, createdAt: 0 } });
  await adminCreateOrg("acme", createOrg);
  expect(createOrg).toHaveBeenCalledWith(
    "/api/admin/orgs",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "acme" }) })
  );

  const rename = mockFetch(200, { org: { id: 1, name: "new", archivedAt: null, createdAt: 0 } });
  await adminRenameOrg(1, "new", rename);
  expect(rename).toHaveBeenCalledWith("/api/admin/orgs/1", expect.objectContaining({ method: "PATCH" }));

  const archive = mockFetch(204, undefined);
  await adminArchiveOrg(1, archive);
  expect(archive).toHaveBeenCalledWith("/api/admin/orgs/1", expect.objectContaining({ method: "DELETE" }));

  const listUsers = mockFetch(200, { users: [] });
  await adminListUsers(listUsers);
  expect(listUsers).toHaveBeenCalledWith("/api/admin/users", expect.objectContaining({ credentials: "include" }));

  const createUser = mockFetch(201, { user: { id: 2, username: "b", email: "b@x.com", isAdmin: false } });
  await adminCreateUser("b", "b@x.com", "a-real-password", createUser);
  expect(createUser).toHaveBeenCalledWith(
    "/api/admin/users",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ username: "b", email: "b@x.com", password: "a-real-password" }) })
  );

  const editUser = mockFetch(200, { user: { id: 2, username: "b", email: "b@x.com", isAdmin: true } });
  await adminEditUser(2, { isAdmin: true }, editUser);
  expect(editUser).toHaveBeenCalledWith(
    "/api/admin/users/2",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ isAdmin: true }) })
  );

  const deactivate = mockFetch(204, undefined);
  await adminDeactivateUser(2, deactivate);
  expect(deactivate).toHaveBeenCalledWith("/api/admin/users/2", expect.objectContaining({ method: "DELETE" }));
});

test("fetchRetentionSettings/updateRetentionSettings hit /api/admin/retention", async () => {
  const get = mockFetch(200, { maxAgeDays: 30, maxTotalBytes: null, maxJobs: null, totalArtifactBytes: 4096 });
  const result = await fetchRetentionSettings(get);
  expect(get).toHaveBeenCalledWith("/api/admin/retention", expect.objectContaining({ credentials: "include" }));
  expect(result).toEqual({ maxAgeDays: 30, maxTotalBytes: null, maxJobs: null, totalArtifactBytes: 4096 });

  const put = mockFetch(200, { maxAgeDays: 14, maxTotalBytes: null, maxJobs: null, totalArtifactBytes: 4096 });
  await updateRetentionSettings({ maxAgeDays: 14, maxTotalBytes: null, maxJobs: null }, put);
  expect(put).toHaveBeenCalledWith(
    "/api/admin/retention",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ maxAgeDays: 14, maxTotalBytes: null, maxJobs: null }),
    })
  );
});

test("updateRetentionSettings surfaces the server's specific validation error", async () => {
  const put = mockFetch(400, { error: "maxAgeDays, maxTotalBytes and maxJobs must each be a non-negative integer or null" });
  await expect(updateRetentionSettings({ maxAgeDays: -1, maxTotalBytes: null, maxJobs: null }, put)).rejects.toThrow(
    /non-negative integer/
  );
});
