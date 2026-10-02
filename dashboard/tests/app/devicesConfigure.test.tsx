import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import ConfigurePage from "../../src/app/devices/configure/page";
import * as api from "../../src/lib/api";
import type { DeviceEntry } from "../../src/lib/api";

jest.mock("../../src/lib/navigate");
// jest.mock + requireActual, not jest.spyOn - named exports of api.ts cannot be
// spied on in this project's Jest setup (see tests/app/devices.test.tsx).
jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchSession: jest.fn(),
  fetchDevices: jest.fn(),
  renameDevice: jest.fn(),
  setDeviceResetPolicy: jest.fn(),
}));
jest.mock("next/navigation", () => ({ useSearchParams: jest.fn() }));

const DEVICE: DeviceEntry = {
  id: "RF8M40H8RFP",
  label: "S10",
  model: "SM-G973F",
  isActive: true,
  state: "device",
  resetPolicy: "app-only",
};

function session(isAdmin: boolean) {
  (api.fetchSession as jest.Mock).mockResolvedValue({
    user: { id: 1, username: "admin", email: "a@x.com", isAdmin },
    orgs: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  session(true);
  (useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams({ device: DEVICE.id }));
  (api.fetchDevices as jest.Mock).mockResolvedValue({
    devices: [DEVICE],
    runnerVersion: "0.1.75",
    artifactBytes: 0,
  });
});

const save = () => fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

test("shows the device's current name and policy", async () => {
  render(<ConfigurePage />);

  expect(await screen.findByDisplayValue("S10")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /app only/i })).toBeChecked();
  // Each option states its consequence - the reason this left the card.
  expect(screen.getByText(/history, cookies, open tabs/i)).toBeInTheDocument();
});

test("an unknown device says so rather than rendering an empty form", async () => {
  (api.fetchDevices as jest.Mock).mockResolvedValue({ devices: [], runnerVersion: "x", artifactBytes: 0 });
  render(<ConfigurePage />);

  expect(await screen.findByRole("alert")).toHaveTextContent(DEVICE.id);
});

test("saving only a new name calls only the rename endpoint", async () => {
  (api.renameDevice as jest.Mock).mockResolvedValue({ ...DEVICE, label: "Desk phone" });
  render(<ConfigurePage />);
  await screen.findByDisplayValue("S10");

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Desk phone" } });
  save();

  await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith(DEVICE.id, "Desk phone"));
  expect(api.setDeviceResetPolicy).not.toHaveBeenCalled();
});

test("escalating to app-and-browser confirms before calling the API", async () => {
  (api.setDeviceResetPolicy as jest.Mock).mockResolvedValue({ ...DEVICE, resetPolicy: "app-and-browser" });
  render(<ConfigurePage />);
  await screen.findByDisplayValue("S10");

  fireEvent.click(screen.getByRole("radio", { name: /app and browser/i }));
  save();

  // A radio is easy to nudge; the destructive change must not be saveable by drift.
  expect(api.setDeviceResetPolicy).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/permanently, starting with the next job/i)).toBeInTheDocument();

  fireEvent.click(dialog.querySelector(".ui-primary")!);

  await waitFor(() =>
    expect(api.setDeviceResetPolicy).toHaveBeenCalledWith(DEVICE.id, "app-and-browser")
  );
  expect(api.renameDevice).not.toHaveBeenCalled();
});

test("de-escalating needs no confirmation - it deletes nothing", async () => {
  (api.fetchDevices as jest.Mock).mockResolvedValue({
    devices: [{ ...DEVICE, resetPolicy: "app-and-browser" }],
    runnerVersion: "x",
    artifactBytes: 0,
  });
  (api.setDeviceResetPolicy as jest.Mock).mockResolvedValue({ ...DEVICE, resetPolicy: "app-only" });
  render(<ConfigurePage />);
  await screen.findByDisplayValue("S10");

  fireEvent.click(screen.getByRole("radio", { name: /app only/i }));
  save();

  await waitFor(() => expect(api.setDeviceResetPolicy).toHaveBeenCalledWith(DEVICE.id, "app-only"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a non-admin cannot change the policy but can still rename", async () => {
  session(false);
  (api.renameDevice as jest.Mock).mockResolvedValue({ ...DEVICE, label: "Desk phone" });
  render(<ConfigurePage />);
  await screen.findByDisplayValue("S10");

  await waitFor(() => expect(screen.getByRole("radio", { name: /app and browser/i })).toBeDisabled());

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Desk phone" } });
  save();

  await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith(DEVICE.id, "Desk phone"));
});

test("save is disabled with nothing changed, and with a blank name", async () => {
  render(<ConfigurePage />);
  await screen.findByDisplayValue("S10");

  expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "   " } });
  expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
});

test("a failed save surfaces the server's message", async () => {
  (api.renameDevice as jest.Mock).mockRejectedValue(new api.ApiError(400, "label must not be empty"));
  render(<ConfigurePage />);
  await screen.findByDisplayValue("S10");

  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Desk phone" } });
  save();

  expect(await screen.findByRole("alert")).toHaveTextContent("label must not be empty");
});
