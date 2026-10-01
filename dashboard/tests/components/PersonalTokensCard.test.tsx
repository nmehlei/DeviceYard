import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PersonalTokensCard from "../../src/components/PersonalTokensCard";

const TOKENS = [
  { id: 1, userId: 7, label: "laptop", value: "secret-value-1", createdAt: 1756700000000, lastUsedAt: null },
];

beforeEach(() => {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return { ok: true, status: 201, json: async () => ({ token: { id: 2, userId: 7, label: "desktop", value: "secret-value-2", createdAt: 1756700001000, lastUsedAt: null } }) } as Response;
    }
    if (init?.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => ({ tokens: TOKENS }) } as Response;
  }) as unknown as typeof fetch;
});

describe("PersonalTokensCard", () => {
  it("lists tokens with the value masked", async () => {
    render(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());
    expect(screen.queryByText("secret-value-1")).not.toBeInTheDocument();
  });

  it("reveals a value on demand, because tokens here are retrievable by design", async () => {
    render(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    expect(await screen.findByText("secret-value-1")).toBeInTheDocument();
  });

  it("says what a token is for when there are none", async () => {
    (global.fetch as jest.Mock).mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ tokens: [] }) }));
    render(<PersonalTokensCard open={true} />);
    expect(await screen.findByText(/every org you belong to/i)).toBeInTheDocument();
  });

  it("creates a token from a label", async () => {
    render(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /create token/i }));
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: "desktop" } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await waitFor(() => {
      // Asserting the body, not just the method: a fixed/ignored-label
      // implementation would still match method:"POST" but send the wrong
      // (or no) label.
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/me/tokens",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ label: "desktop" }) })
      );
    });
  });

  it("confirms before revoking, naming the token", async () => {
    render(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    // Naming the label in the confirmation is the point: revoking the wrong
    // one silently breaks a machine somewhere else.
    expect(screen.getByRole("dialog")).toHaveTextContent("laptop");

    // DELETE must not fire until the confirmation is accepted.
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/me/tokens/1"),
      expect.objectContaining({ method: "DELETE" })
    );

    fireEvent.click(screen.getByRole("dialog").querySelector(".ui-primary")!);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/me/tokens/1"),
        expect.objectContaining({ method: "DELETE" })
      )
    );
  });

  it("confirms a successful copy so the user isn't left guessing whether it worked", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    expect(writeText).toHaveBeenCalledWith("secret-value-1");
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("surfaces a visible error when the clipboard write fails", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });

    render(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    expect(await screen.findByText(/failed to copy/i)).toBeInTheDocument();
  });

  // I5: this card is mounted unconditionally inside AccountDialog, so a
  // pre-fix useEffect(reload, []) fetched every logged-in-in-a-person's
  // decrypted PATs on every dashboard page load, not just when they opened
  // Account settings. Against the unfixed code (an effect with a `[]` dep
  // array, ignoring `open`), the fetch fires immediately regardless of
  // `open`, so this assertion fails there.
  it("does not fetch tokens while closed, and fetches once opened", async () => {
    const { rerender } = render(<PersonalTokensCard open={false} />);
    expect(global.fetch).not.toHaveBeenCalled();

    rerender(<PersonalTokensCard open={true} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/me/tokens", expect.anything()));
  });

  // I5: reload() used to swallow any fetch failure into an empty array,
  // which then rendered the "what a PAT is for" empty-state copy as though
  // the person genuinely had none - indistinguishable from a real failure.
  it("surfaces a load failure instead of rendering the empty state", async () => {
    (global.fetch as jest.Mock).mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }));
    render(<PersonalTokensCard open={true} />);
    expect(await screen.findByText(/failed to load personal tokens/i)).toBeInTheDocument();
    expect(screen.queryByText(/every org you belong to/i)).not.toBeInTheDocument();
  });
});
