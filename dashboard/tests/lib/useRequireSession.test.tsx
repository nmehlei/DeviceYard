import { renderHook, waitFor } from "@testing-library/react";
import { useRequireSession } from "../../src/lib/useRequireSession";
import * as api from "../../src/lib/api";
import { ApiError } from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("resolves to ok when fetchSession succeeds", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
  const { result } = renderHook(() => useRequireSession());
  await waitFor(() => expect(result.current).toBe("ok"));
});

test("redirects to /login on a 401 ApiError", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new ApiError(401, "no session"));
  const { result } = renderHook(() => useRequireSession());
  await waitFor(() => expect(result.current).toBe("redirecting"));
  expect(navigate).toHaveBeenCalledWith("/login");
});

test("redirects to /login on a 403 ApiError", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new ApiError(403, "invalid"));
  const { result } = renderHook(() => useRequireSession());
  await waitFor(() => expect(result.current).toBe("redirecting"));
  expect(navigate).toHaveBeenCalledWith("/login");
});

test("does not redirect on a non-401/403 error", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new ApiError(502, "device down"));
  const { result } = renderHook(() => useRequireSession());
  await waitFor(() => expect(result.current).not.toBe("checking"));
  expect(result.current).toBe("ok");
  expect(navigate).not.toHaveBeenCalled();
});
