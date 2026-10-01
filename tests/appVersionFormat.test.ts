jest.mock("app-binary-info", () => {
  const actual = jest.requireActual("app-binary-info");
  return { ...actual, parseApk: jest.fn() };
});

import { resolveAppIdFromApk } from "../src/appId";

describe("resolveAppIdFromApk - formatAppVersion edge cases", () => {
  const { parseApk } = jest.requireMock("app-binary-info") as { parseApk: jest.Mock };

  beforeEach(() => parseApk.mockReset());

  test("versionName and versionCode both present formats as 'name (code)'", async () => {
    parseApk.mockResolvedValue({ packageName: "com.example.app", versionName: "2.4.1", versionCode: 240 });
    const info = await resolveAppIdFromApk("/fake/path.apk");
    expect(info.appVersion).toBe("2.4.1 (240)");
  });

  test("only versionName present formats as just the name", async () => {
    parseApk.mockResolvedValue({ packageName: "com.example.app", versionName: "2.4.1" });
    const info = await resolveAppIdFromApk("/fake/path.apk");
    expect(info.appVersion).toBe("2.4.1");
  });

  test("neither versionName nor versionCode present resolves to null", async () => {
    parseApk.mockResolvedValue({ packageName: "com.example.app" });
    const info = await resolveAppIdFromApk("/fake/path.apk");
    expect(info.appVersion).toBeNull();
  });
});
