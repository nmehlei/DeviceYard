import { textResult, imageResult, errorResult } from "../../src/mcp/result";

describe("tool results", () => {
  it("wraps text", () => {
    expect(textResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("marks errors with isError so the harness can distinguish them", () => {
    expect(errorResult("bad")).toEqual({ content: [{ type: "text", text: "bad" }], isError: true });
  });

  it("emits base64 image content with a leading text caption", () => {
    const result = imageResult(Buffer.from([0x89, 0x50]), "image/png", "step 3 screenshot");
    expect(result.content[0]).toEqual({ type: "text", text: "step 3 screenshot" });
    expect(result.content[1]).toEqual({
      type: "image",
      data: Buffer.from([0x89, 0x50]).toString("base64"),
      mimeType: "image/png",
    });
    expect(result.isError).toBeUndefined();
  });
});
