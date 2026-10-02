export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Image content always carries a text caption first: a bare image in the
 * transcript loses which step and which job it came from, which is the only
 * thing that makes it diagnostic rather than decorative. */
export function imageResult(bytes: Buffer, mimeType: string, caption: string): ToolResult {
  return {
    content: [
      { type: "text", text: caption },
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
  };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
