import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import ControlPage from "../../src/app/devices/control/page";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/navigate");
// jest.mock + requireActual, not jest.spyOn - named exports of api.ts cannot be
// spied on in this project's Jest setup (see tests/app/devices.test.tsx).
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
}));
jest.mock("next/navigation", () => ({ useSearchParams: jest.fn() }));

class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = "";
  readonly url: string;
  constructor(url: string) { this.url = url; FakeSocket.last = this; }
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  jest.clearAllMocks();
  FakeSocket.last = undefined;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "admin", email: "a@x.com", isAdmin: true },
    orgs: [],
  });
});

const withQuery = (query: Record<string, string>) =>
  (useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams(query));

test("opens the screen for the device named in the query string", async () => {
  withQuery({ device: "R58M" });
  render(<ControlPage />);
  await waitFor(() => expect(FakeSocket.last).toBeDefined());
  expect(FakeSocket.last!.url).toContain("/api/devices/R58M/control");
  expect(screen.getByText("R58M")).toBeInTheDocument();
});

test("says so when no device is selected, rather than opening a socket to nothing", async () => {
  withQuery({});
  render(<ControlPage />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no device selected/i));
  expect(FakeSocket.last).toBeUndefined();
});
