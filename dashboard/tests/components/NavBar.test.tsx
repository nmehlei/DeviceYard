import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NavBar } from "../../src/components/NavBar";
import * as api from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";
import { usePathname } from "next/navigation";

jest.mock("../../src/lib/navigate");
// jest.mock + requireActual, not jest.spyOn(api, ...) - see Task 6's brief
// for why named exports of api.ts can't be spied on directly here.
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  logout: jest.fn(),
}));
// NavBar reads the current path via usePathname() (not window.location)
// now that it stays mounted across client-side Link navigations - mocked
// here the same way fetchSession is, driven per-test instead of pushState.
jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (usePathname as jest.Mock).mockReturnValue("/");
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
  // NavBar always mounts AccountDialog (visibility is just the <dialog>'s
  // open/closed state), and PersonalTokensCard mounts inside it - but (I5)
  // its fetch of /api/me/tokens is now gated on the dialog's `open` prop, so
  // this only actually fires in the tests below that open Account settings.
  // Stubbed globally regardless, so any test that does open it doesn't hit a
  // real server.
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tokens: [] }),
  })) as unknown as typeof fetch;
});

test("renders links to Jobs and Devices", () => {
  render(<NavBar />);
  expect(screen.getByRole("link", { name: /jobs/i })).toHaveAttribute("href", "/history");
  expect(screen.getByRole("link", { name: /^devices$/i })).toHaveAttribute("href", "/devices");
});

test("sign out calls the logout API then navigates to /login", async () => {
  (api.logout as jest.Mock).mockResolvedValue(undefined);

  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

  await waitFor(() => expect(api.logout).toHaveBeenCalled());
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});

test("sign out still navigates to /login when logout() rejects", async () => {
  (api.logout as jest.Mock).mockRejectedValue(new Error("network down"));

  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});

test("account menu's Account settings item opens the account dialog", () => {
  if (!HTMLDialogElement.prototype.showModal) {
    // See tests/components/AccountDialog.test.tsx for why this is needed -
    // jsdom does not implement <dialog>'s modal behavior.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  expect(screen.getByRole("link", { name: /account settings/i })).toHaveAttribute("href", "/account");
});

test("account menu includes a link to /about", () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  expect(screen.getByRole("link", { name: /^about$/i })).toHaveAttribute("href", "/about");
});

test("account menu includes a link to /mcp-setup", () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  expect(screen.getByRole("link", { name: /connect an agent/i })).toHaveAttribute("href", "/mcp-setup");
});

test("account menu groups resources and links to formatted API documentation", () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));

  expect(screen.getByRole("group", { name: "Account" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Resources" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /api documentation/i }))
    .toHaveAttribute("href", "/api-docs");
});

test("account menu shows the logged-in username", async () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  expect((await screen.findAllByText("n")).length).toBeGreaterThan(0);
});

test("account menu opens on click and closes on outside click", () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();

  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
});

test("renders on non-login paths", async () => {
  (usePathname as jest.Mock).mockReturnValue("/devices");
  render(<NavBar />);
  expect(await screen.findByRole("link", { name: /jobs/i })).toBeInTheDocument();
});

test("renders nothing on /login", async () => {
  (usePathname as jest.Mock).mockReturnValue("/login");
  const { container } = render(<NavBar />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test("shows the Admin nav link only for an admin user", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "admin", email: "a@x.com", isAdmin: true },
    orgs: [],
  });
  render(<NavBar />);
  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  expect(await screen.findByRole("link", { name: /farm administration/i })).toHaveAttribute("href", "/admin");
});

test("does not show the Admin nav link for a non-admin user", async () => {
  render(<NavBar />);
  await screen.findByRole("link", { name: /^jobs$/i });
  expect(screen.queryByRole("link", { name: /farm administration/i })).not.toBeInTheDocument();
});

// I5: PersonalTokensCard always mounts inside AccountDialog, so the
// pre-fix useEffect(reload, []) fetched every decrypted PAT on every
// dashboard navigation - not just when the person opened Account settings.
// This fails against the unfixed code, where global.fetch is called for
// /api/me/tokens immediately on NavBar's first render.
test("does not fetch personal access tokens until Account settings is opened", async () => {
  render(<NavBar />);
  await screen.findByRole("button", { name: /account menu/i });
  expect(global.fetch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
  fireEvent.click(screen.getByRole("link", { name: /account settings/i }));

  expect(global.fetch).not.toHaveBeenCalled();
});
