import { loadDismissed, pendingSetupWarnings, saveDismissed, visibleWarnings, warningKey } from "../../src/lib/setupWarnings";
import type { DeviceEntry } from "../../src/lib/api";

const device = (overrides: Partial<DeviceEntry>): DeviceEntry => ({
  id: "RF8M40H8RFP",
  label: "Galaxy S10",
  model: "SM-G973F",
  isActive: true,
  state: "device",
  resetPolicy: "app-only",
  ...overrides,
});

const check = (id: string, ok: boolean | null) => ({ id, title: `title ${id}`, detail: `detail ${id}`, ok });

beforeEach(() => localStorage.clear());

test("only checks that read as not applied become warnings", () => {
  const warnings = pendingSetupWarnings([
    device({ setupChecks: [check("a", false), check("b", true), check("c", null)] }),
  ]);
  expect(warnings).toEqual([
    { deviceId: "RF8M40H8RFP", deviceLabel: "Galaxy S10", checkId: "a", title: "title a", detail: "detail a" },
  ]);
});

test("devices the edition does not allow are left out, since their fix cannot be applied", () => {
  expect(pendingSetupWarnings([device({ isAvailable: false, setupChecks: [check("a", false)] })])).toEqual([]);
});

test("devices without setup checks produce no warnings", () => {
  expect(pendingSetupWarnings([device({ setupChecks: undefined })])).toEqual([]);
});

test("a dismissed warning is hidden, a different check on the same device is not", () => {
  const warnings = pendingSetupWarnings([device({ setupChecks: [check("a", false), check("b", false)] })]);
  const visible = visibleWarnings(warnings, new Set([warningKey(warnings[0])]));
  expect(visible.map((w) => w.checkId)).toEqual(["b"]);
});

test("dismissals survive a reload through localStorage", () => {
  saveDismissed(new Set(["RF8M40H8RFP:a"]));
  expect(loadDismissed()).toEqual(new Set(["RF8M40H8RFP:a"]));
});

test("unreadable storage counts as nothing dismissed", () => {
  localStorage.setItem("deviceyard-dismissed-setup-checks", "{not json");
  expect(loadDismissed()).toEqual(new Set());
});
