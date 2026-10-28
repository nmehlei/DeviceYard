import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { DeviceCard } from "../../src/components/DeviceCard";
import * as api from "../../src/lib/api";
import type { DeviceEntry } from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchDeviceEvents: jest.fn(),
}));

if (!URL.revokeObjectURL) URL.revokeObjectURL = jest.fn();

const device: DeviceEntry = {
  id: "RF8M40H8RFP", label: "Pixel 7", model: "Pixel 7", isActive: true, state: "device", resetPolicy: "app-only",
};

beforeEach(() => {
  (api.fetchDeviceEvents as jest.Mock).mockResolvedValue([]);
});

test("device card shows isolation support only when reported", async () => {
  const { rerender } = render(<DeviceCard device={device} onChanged={() => {}} />);
  expect(await screen.findByText("Pixel 7", { selector: "h2" })).toBeInTheDocument();
  expect(screen.queryByText("Work-profile isolation")).not.toBeInTheDocument();

  rerender(<DeviceCard device={{ ...device, isolationCapable: true }} onChanged={() => {}} />);
  expect(screen.getByText("Work-profile isolation")).toBeInTheDocument();
  expect(screen.getByText("Supported")).toBeInTheDocument();

  rerender(<DeviceCard device={{ ...device, isolationCapable: false }} onChanged={() => {}} />);
  expect(screen.getByText("Not supported")).toBeInTheDocument();

  rerender(<DeviceCard device={{ ...device, isolationCapable: null }} onChanged={() => {}} />);
  expect(screen.getByText("Unknown")).toBeInTheDocument();
});
