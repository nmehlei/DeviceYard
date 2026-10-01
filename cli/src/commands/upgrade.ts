import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Io } from "../main";
import { CliError, EXIT_ERROR, EXIT_OK } from "../exit";

/** Re-runs the same resolution install.sh does, so there is exactly one
 * definition of "which binary is current" rather than two that can disagree.
 *
 * Only meaningful for a binary install. An npm install upgrades through npm,
 * and silently replacing a file inside node_modules would leave npm's idea of
 * the installed version wrong - so say so instead of doing it. */
export function runUpgrade(io: Io, argv0: string = process.argv[0]): number {
  try {
    const self = fs.realpathSync(argv0);

    if (self.split(path.sep).includes("node_modules")) {
      throw new CliError(
        "this deviceyard was installed with npm - upgrade it with npm:\n" +
        "  npm install -g @deviceyard/cli@latest",
      );
    }

    const url = io.env.DEVICEYARD_URL ?? io.env.MOBILE_FARM_URL;
    if (!url) {
      throw new CliError(
        "set DEVICEYARD_URL to the farm serving the installer, or re-run its install.sh yourself:\n" +
        "  curl -fsSL https://your-farm/cli/install.sh | sh",
      );
    }

    // <prefix>/bin/deviceyard -> <prefix>. Reinstalling into the same prefix
    // is what makes `upgrade` replace this binary rather than add a second one
    // somewhere else on PATH.
    const prefix = path.dirname(path.dirname(self));

    io.out(`upgrading ${self} from ${url}/cli/install.sh`);
    execFileSync("sh", ["-c", `curl -fsSL "$0/cli/install.sh" | sh`, url], {
      stdio: "inherit",
      env: { ...process.env, DEVICEYARD_PREFIX: prefix },
    });
    return EXIT_OK;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
}
