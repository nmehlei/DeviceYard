import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import DevicesPage from "../../src/app/devices/page";
import * as api from "../../src/lib/api";
import type { DeviceEntry } from "../../src/lib/api";
import { navigate } from "../../src/lib/navigate";

jest.mock("../../src/lib/navigate");
// jest.mock + requireActual, not jest.spyOn(api, ...) - named exports of
// api.ts can't be spied on directly in this project's Jest setup (see
// tests/app/jobs.test.tsx).
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  fetchDevices: jest.fn(),
  fetchDeviceEvents: jest.fn(),
  activateDevice: jest.fn(),
  enableDevice: jest.fn(),
  disableDevice: jest.fn(),
  removeDevice: jest.fn(),
  rebootDevice: jest.fn(),
  addDevice: jest.fn(),
  takeDeviceScreenshot: jest.fn(),
  setDeviceResetPolicy: jest.fn(),
  fixDeviceSetupCheck: jest.fn(),
}));

const ACTIVE: DeviceEntry = {
  id: "RF8M40H8RFP",
  label: "RF8M40H8RFP",
  model: "Pixel 7",
  isActive: true,
  state: "device",
  resetPolicy: "app-only",
};

const INACTIVE: DeviceEntry = {
  id: "loaner-1",
  label: "Loaner",
  model: null,
  isActive: false,
  state: "offline",
  resetPolicy: "app-only",
};

// jsdom has no object-URL machinery at all - DeviceCard revokes the blob URL
// a screenshot capture created on unmount/replacement, so the environment
// needs a stand-in or that cleanup effect throws.
if (!URL.revokeObjectURL) URL.revokeObjectURL = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: false },
    orgs: [],
  });
  (api.fetchDeviceEvents as jest.Mock).mockResolvedValue([]);
  (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [ACTIVE, INACTIVE], runnerVersion: "0.1.25", artifactBytes: 6_757_890 });
});

test("renders every device with its state, model, serial, and the active badge", async () => {
  render(<DevicesPage />);

  expect((await screen.findAllByText("Enabled for jobs")).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/RF8M40H8RFP/)).not.toHaveLength(0);
  expect(screen.getByText("Pixel 7")).toBeInTheDocument();
  expect(screen.getByText("Online")).toBeInTheDocument();
  expect(screen.getByText("Loaner")).toBeInTheDocument();
  expect(screen.getByText("Not connected")).toBeInTheDocument();
  expect(screen.getByText(/0\.1\.25/)).toBeInTheDocument();
});

test("artifact storage is reported once for the farm, not per device", async () => {
  render(<DevicesPage />);
  await screen.findAllByText("Enabled for jobs");
  // Two devices are rendered; the total belongs to the host, so exactly one
  // element carries it. Repeating it per card reads as per-device usage.
  expect(screen.getAllByTestId("artifact-bytes")).toHaveLength(1);
  // One decimal for MB (two for GB) - unchanged formatting, but this
  // expectation was never actually reached before: the assertion above it
  // threw on the duplicated elements, so its previous "6.44 MB" was wrong
  // and nobody found out.
  expect(screen.getByTestId("artifact-bytes")).toHaveTextContent("6.4 MB");
  const cards = screen.getAllByText(/RF8M40H8RFP|Loaner/);
  cards.forEach((el) => {
    const card = el.closest("div.rounded-lg");
    if (card) expect(within(card as HTMLElement).queryByTestId("artifact-bytes")).not.toBeInTheDocument();
  });
});

test("no artifact figure is shown on a farm that has stored nothing yet", async () => {
  (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [ACTIVE], runnerVersion: "0.1.25", artifactBytes: 0 });
  render(<DevicesPage />);
  await screen.findAllByText("Enabled for jobs");
  expect(screen.queryByTestId("artifact-bytes")).not.toBeInTheDocument();
});

test("enabling an inactive device requires a confirm click, then calls the API and refreshes", async () => {
  (api.enableDevice as jest.Mock).mockResolvedValue({ ...INACTIVE, isActive: true });
  render(<DevicesPage />);
  await screen.findByText("Loaner");

  screen.getAllByText("Manage device →").forEach(element => fireEvent.click(element));
  fireEvent.click(screen.getByRole("button", { name: /^enable$/i }));
  expect(api.enableDevice).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.enableDevice).toHaveBeenCalledWith("loaner-1"));
  await waitFor(() => expect(api.fetchDevices).toHaveBeenCalledTimes(2));
});

test("rebooting the active (online) device requires a confirm click", async () => {
  (api.rebootDevice as jest.Mock).mockResolvedValue(undefined);
  render(<DevicesPage />);
  await screen.findAllByText("Enabled for jobs");

  screen.getAllByText("Manage device →").forEach(element => fireEvent.click(element));
  fireEvent.click(screen.getByRole("button", { name: /reboot/i }));
  expect(api.rebootDevice).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  await waitFor(() => expect(api.rebootDevice).toHaveBeenCalledWith("RF8M40H8RFP"));
});

test("reboot is not offered for a device that is not currently connected", async () => {
  render(<DevicesPage />);
  await screen.findByText("Loaner");
  const loanerCard = screen.getByText("Loaner").closest("div.rounded-lg") as HTMLElement;
  expect(within(loanerCard).queryByRole("button", { name: /reboot/i })).not.toBeInTheDocument();
});

test("a failed enable shows the server's error instead of silently doing nothing", async () => {
  (api.enableDevice as jest.Mock).mockRejectedValue(new api.ApiError(409, "a job is currently running"));
  render(<DevicesPage />);
  await screen.findByText("Loaner");

  screen.getAllByText("Manage device →").forEach(element => fireEvent.click(element));
  fireEvent.click(screen.getByRole("button", { name: /^enable$/i }));
  fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);

  expect(await screen.findByText("a job is currently running")).toBeInTheDocument();
});

test("taking a screenshot on the active device shows it inline", async () => {
  (api.takeDeviceScreenshot as jest.Mock).mockResolvedValue("blob:fake-url");
  render(<DevicesPage />);
  await screen.findAllByText("Enabled for jobs");

  fireEvent.click(screen.getByRole("button", { name: /take screenshot/i }));

  expect(await screen.findByAltText(/RF8M40H8RFP screenshot/i)).toHaveAttribute("src", "blob:fake-url");
});

test("adding a device opens a form, submits it, and shows the returned setup instructions", async () => {
  (api.addDevice as jest.Mock).mockResolvedValue({
    device: { id: "new-1", label: "New", model: null, isActive: false, state: "offline" },
    setupInstructions: ["Connect over USB.", "Enable USB debugging."],
  });
  render(<DevicesPage />);
  await screen.findAllByText("Enabled for jobs");

  fireEvent.click(screen.getByRole("button", { name: /add device/i }));
  fireEvent.change(screen.getByLabelText(/device id/i), { target: { value: "new-1" } });
  fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "New" } });
  fireEvent.click(screen.getByRole("button", { name: /register device/i }));

  await waitFor(() => expect(api.addDevice).toHaveBeenCalledWith("new-1", "New"));
  expect(await screen.findByText("Connect over USB.")).toBeInTheDocument();
});

test("redirects to /login instead of rendering when the session is invalid", async () => {
  (api.fetchSession as jest.Mock).mockRejectedValue(new api.ApiError(401, "missing bearer token"));
  render(<DevicesPage />);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/login"));
});

describe("reset policy", () => {
  test("the current policy is shown on the card", async () => {
    (api.fetchDevices as jest.Mock).mockResolvedValue({
      devices: [{ ...ACTIVE, resetPolicy: "app-and-browser" }],
      runnerVersion: "0.1.25",
      artifactBytes: 0,
    });
    render(<DevicesPage />);

    expect(await screen.findByText("App and browser")).toBeInTheDocument();
  });

  test("the card links to the configure screen instead of carrying the setting", async () => {
    render(<DevicesPage />);
    await screen.findByText("Loaner");

    // The policy is a setting, not an action: it must not sit among the verbs.
    expect(screen.queryByRole("button", { name: /also reset browser/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset app only/i })).not.toBeInTheDocument();

    const link = screen.getAllByRole("link", { name: /configure device/i })[0];
    expect(link).toHaveAttribute("href", `/devices/configure?device=${ACTIVE.id}`);
  });
});

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

  test("the card carries the anchor the app-wide warning bar links to", async () => {
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);

    await screen.findByText("USB debugging approval expires");
    expect(document.getElementById(`device-${NEEDS_SETUP.id}`)).toHaveTextContent(NEEDS_SETUP.label);
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

    // By text, not role: the page's EditionCard already renders its own
    // role="alert" in this fixture, which findByRole would return first.
    const message = await screen.findByText("setting did not take effect (read back: null)");
    expect(message).toHaveAttribute("role", "alert");
  });

  test("the summary counts devices needing setup, not failing checks", async () => {
    (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [NEEDS_SETUP, INACTIVE], runnerVersion: "0.1.25", artifactBytes: 0 });
    render(<DevicesPage />);

    expect(await screen.findByTestId("needs-setup")).toHaveTextContent("1 device");
  });
});

test("no Fix button on a device the current edition does not allow - the route would always refuse", async () => {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "n", email: "n@x.com", isAdmin: true },
    orgs: [],
  });
  const locked: DeviceEntry = {
    ...ACTIVE,
    isAvailable: false,
    setupChecks: [{ id: "adb-auth-timeout", title: "USB debugging approval expires", detail: "d", ok: false }],
  };
  (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [locked], runnerVersion: "0.1.25", artifactBytes: 0 });
  render(<DevicesPage />);

  expect(await screen.findByText("USB debugging approval expires")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^fix:/i })).not.toBeInTheDocument();
});
