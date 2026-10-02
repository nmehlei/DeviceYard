import fs from "fs";
import path from "path";
import { findForbiddenImports, FORBIDDEN_FROM_SHARED } from "./boundaryScanner";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function scan(dir: string, forbidden?: string[]): string[] {
  const offenders: string[] = [];
  for (const file of walk(dir)) {
    const source = fs.readFileSync(file, "utf8");
    for (const spec of findForbiddenImports(source, forbidden)) {
      offenders.push(`${path.relative(process.cwd(), file)} imports ${spec}`);
    }
  }
  return offenders;
}

const repoRoot = path.join(__dirname, "..", "..");

describe("src/mcp boundary", () => {
  it("imports nothing from the farm's in-process modules", () => {
    expect(scan(path.join(repoRoot, "src", "mcp"))).toEqual([]);
  });
});

describe("shared boundary", () => {
  // Most of what src/mcp/ used to hold now lives in shared/, so without this
  // the scan above guards only re-export shims and proves nothing.
  it("imports nothing from src/ and nothing server-side", () => {
    expect(scan(path.join(repoRoot, "shared"), FORBIDDEN_FROM_SHARED)).toEqual([]);
  });

  it("is actually scanning files", () => {
    // A walk() that silently returned [] would make the assertion above pass
    // for the wrong reason - the exact failure this whole test exists to catch.
    expect(walk(path.join(repoRoot, "shared")).length).toBeGreaterThanOrEqual(5);
  });
});
