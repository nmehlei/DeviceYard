import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SetupWarningBar } from "../../src/components/SetupWarningBar";
import type { DeviceEntry } from "../../src/lib/api";

const device = (id: string, checks: { id: string; ok: boolean | null }[]): DeviceEntry => ({
  id,
  label: `Phone ${id}`,
  model: null,
  isActive: true,
  state: "device",
  resetPolicy: "app-only",
  setupChecks: checks.map((c) => ({ id: c.id, title: `Title ${c.id}`, detail: `Detail ${c.id}`, ok: c.ok })),
});

beforeEach(() => localStorage.clear());

test("renders nothing when every check is applied", () => {
  const { container } = render(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: true }])]} admin />);
  expect(container).toBeEmptyDOMElement();
});

test("one open check names the device and check and links admins to that device's card", () => {
  render(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: false }])]} admin />);
  expect(screen.getByRole("status")).toHaveTextContent("Phone d1: Title a");
  expect(screen.getByRole("status")).toHaveTextContent("Detail a");
  expect(screen.getByRole("link", { name: /fix it/i })).toHaveAttribute("href", "/devices#device-d1");
});

test("several open checks are summarised and link to the Devices page", () => {
  render(
    <SetupWarningBar
      devices={[device("d1", [{ id: "a", ok: false }, { id: "b", ok: false }]), device("d2", [{ id: "a", ok: false }])]}
      admin
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent("3 device settings are not applied on 2 devices");
  expect(screen.getByRole("link", { name: /fix them/i })).toHaveAttribute("href", "/devices");
});

test("non-admins are told to ask an admin instead of getting a link", () => {
  render(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: false }])]} admin={false} />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Ask an admin to fix this.");
});

test("Hide removes the bar and keeps it hidden after a remount", () => {
  const devices = [device("d1", [{ id: "a", ok: false }])];
  const { unmount } = render(<SetupWarningBar devices={devices} admin />);
  fireEvent.click(screen.getByRole("button", { name: /hide/i }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  unmount();
  render(<SetupWarningBar devices={devices} admin />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("a hidden check that gets fixed and later regresses shows the bar again", () => {
  const { rerender } = render(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: false }])]} admin />);
  fireEvent.click(screen.getByRole("button", { name: /hide/i }));
  rerender(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: true }])]} admin />);
  rerender(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: false }])]} admin />);
  expect(screen.getByRole("status")).toHaveTextContent("Phone d1: Title a");
});

test("a check that starts failing after a dismissal shows the bar again", () => {
  const { rerender } = render(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: false }])]} admin />);
  fireEvent.click(screen.getByRole("button", { name: /hide/i }));
  rerender(<SetupWarningBar devices={[device("d1", [{ id: "a", ok: false }, { id: "b", ok: false }])]} admin />);
  expect(screen.getByRole("status")).toHaveTextContent("Phone d1: Title b");
});
