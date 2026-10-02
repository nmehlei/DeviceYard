import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UploadLimitCard } from "../../src/components/UploadLimitCard";
import * as api from "../../src/lib/api";

jest.mock("../../src/lib/api", () => ({
  ...jest.requireActual("../../src/lib/api"),
  fetchUploadSettings: jest.fn(),
  updateUploadSettings: jest.fn(),
}));

const MB = 1024 * 1024;

function mockSettings(over: Partial<api.UploadSettings> = {}) {
  (api.fetchUploadSettings as jest.Mock).mockResolvedValue({
    maxUploadBytes: 64 * MB,
    effectiveMaxUploadBytes: 64 * MB,
    defaultMaxUploadBytes: 512 * MB,
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings();
});

test("shows the stored limit in MB", async () => {
  render(<UploadLimitCard />);
  expect(await screen.findByLabelText(/max upload size/i)).toHaveValue("64");
  expect(screen.getByText(/64 MB/)).toBeInTheDocument();
});

test("says when the enforced value is the default nobody has changed", async () => {
  mockSettings({ maxUploadBytes: null, effectiveMaxUploadBytes: 512 * MB });
  render(<UploadLimitCard />);
  expect(await screen.findByText(/512 MB default/)).toBeInTheDocument();
});

test("saving converts MB to bytes", async () => {
  (api.updateUploadSettings as jest.Mock).mockResolvedValue({
    maxUploadBytes: 128 * MB,
    effectiveMaxUploadBytes: 128 * MB,
    defaultMaxUploadBytes: 512 * MB,
  });
  render(<UploadLimitCard />);
  fireEvent.change(await screen.findByLabelText(/max upload size/i), { target: { value: "128" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() => expect(api.updateUploadSettings).toHaveBeenCalledWith({ maxUploadBytes: 128 * MB }));
});

test("an empty field warns that it removes the limit entirely", async () => {
  render(<UploadLimitCard />);
  fireEvent.change(await screen.findByLabelText(/max upload size/i), { target: { value: "" } });
  // Materially different from an empty field on the Retention card, which
  // just leaves a threshold off - this one removes the protection.
  expect(screen.getByText(/no limit at all/i)).toBeInTheDocument();
});

test("an empty field saves null rather than being rejected", async () => {
  (api.updateUploadSettings as jest.Mock).mockResolvedValue({
    maxUploadBytes: null,
    effectiveMaxUploadBytes: null,
    defaultMaxUploadBytes: 512 * MB,
  });
  render(<UploadLimitCard />);
  fireEvent.change(await screen.findByLabelText(/max upload size/i), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() => expect(api.updateUploadSettings).toHaveBeenCalledWith({ maxUploadBytes: null }));
  expect(await screen.findByText(/^no limit$/i)).toBeInTheDocument();
});

test.each(["0", "-5", "abc"])("rejects %p without calling the API", async (value) => {
  render(<UploadLimitCard />);
  fireEvent.change(await screen.findByLabelText(/max upload size/i), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  expect(await screen.findByText(/positive number of megabytes/i)).toBeInTheDocument();
  expect(api.updateUploadSettings).not.toHaveBeenCalled();
});

test("surfaces an API failure", async () => {
  (api.updateUploadSettings as jest.Mock).mockRejectedValue(new api.ApiError(500, "boom"));
  render(<UploadLimitCard />);
  fireEvent.change(await screen.findByLabelText(/max upload size/i), { target: { value: "32" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  expect(await screen.findByText("boom")).toBeInTheDocument();
});

test("surfaces a load failure", async () => {
  (api.fetchUploadSettings as jest.Mock).mockRejectedValue(new Error("nope"));
  render(<UploadLimitCard />);
  expect(await screen.findByText(/failed to load the upload limit/i)).toBeInTheDocument();
});
