import fs from "fs";
import path from "path";
import { FrameTag } from "../../src/control/frameTags";

// The dashboard is a separate build and cannot import backend source, so the
// constants are duplicated. This reads the dashboard copy as text and fails if
// any value differs - a silent mismatch would decode keyframes as PNGs.
test("dashboard frame tags match the backend's", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../dashboard/src/lib/frameTags.ts"), "utf8");
  const match = /export const FrameTag = (\{[^}]*\})/.exec(source);
  expect(match).not.toBeNull();
  const dashboardTags = Function(`return (${match![1]})`)();
  expect(dashboardTags).toEqual(FrameTag);
});
