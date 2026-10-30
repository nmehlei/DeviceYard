import { CliError } from "./exit";
import { nearest } from "./distance";
import { parseDeviceTags } from '../../shared/deviceTags';
import { parseIsolation, type IsolationMode } from '../../shared/isolation';

export interface CloudOptions {
  appFile?: string;
  appFilePositional?: string;
  flowsPath: string;
  apiKey?: string;
  url?: string;
  org?: number;
  envPairs: string[];
  requiredDeviceTags: string[];
  isolation: IsolationMode;
  includeTags: string[];
  excludeTags: string[];
  excludeFlows: string[];
  name?: string;
  async: boolean;
  quiet: boolean;
  json: boolean;
  jsonFile: boolean;
  jsonFileName?: string;
  dryRun: boolean;
  report?: "junit";
  junitPath?: string;
  downloadArtifacts?: "ALL" | "FAILED";
  artifactsPath: string;
  debug: boolean;
}

/** Tier 2. Every `dcd cloud` flag we do not implement, mapped to the actual
 * reason - never "unknown option". This table IS the compatibility promise: a
 * pipeline migrating from `dcd cloud` or `maestro cloud` gets a diagnosis it
 * can act on rather than a parser error that says nothing about why.
 *
 * Keep it in sync with the migration table in docs/guide/cli.md, which is
 * generated from it. */
export const UNSUPPORTED: Readonly<Record<string, string>> = Object.freeze({
  "--ios-device": "this farm runs one configured Android device; iOS is not available",
  "--ios-version": "this farm runs one configured Android device; iOS is not available",
  "--android-device":
    "this farm runs one configured Android device, chosen on the Devices page - a job cannot pick a model",
  "--android-api-level":
    "this farm runs one configured Android device; its API level is whatever that device runs",
  "--retry": "retries are not supported; re-run the job, or handle the retry in your pipeline",
  "--maestro-version": "the farm pins one Maestro version - GET /api/version reports which",
  "--app-binary-id": "uploaded binaries are not retained for reuse; every run uploads its app file",
  "--app-url": "the app must be uploaded from disk; the farm does not fetch app binaries over the network",
  "--google-play": "device capabilities are fixed by the attached hardware",
  "--orientation": "orientation is not controllable per run",
  "--device-locale": "device locale is not controllable per run",
  "--runner-type": "this farm has one runner",
  "--disable-animations": "animation scales are a property of the attached device, not of a run",
  "--show-crosshairs": "crosshair overlays are not supported",
  "--android-no-snapshot": "the farm runs physical hardware, not snapshot-booted emulators",
  "--maestro-chrome-onboarding": "Chrome onboarding control is not supported",
  "--ignore-sha-check": "every run uploads its app file, so there is no SHA cache to bypass",
  "--config": "workspace config files are not read; pass the flags explicitly",
  "--metadata": "arbitrary run metadata is not stored; use --name",
  "--branch": "git metadata is not stored against a run",
  "--commit-sha": "git metadata is not stored against a run",
  "--repo-name": "git metadata is not stored against a run",
  "--pr-number": "git metadata is not stored against a run",
  "--pr-url": "git metadata is not stored against a run",
});

export const KNOWN_OPTIONS = [
  "--api-key", "--url", "--org", "--app-file", "--flows", "--exclude-flows",
  "--device-tags", "--isolation",
  "--include-tags", "--exclude-tags", "--env", "--name", "--async", "--quiet",
  "--json", "--json-file", "--json-file-name", "--dry-run", "--report",
  "--junit-path", "--download-artifacts", "--artifacts-path", "--debug", "--help",
];

/** Default artifact output. A DIRECTORY, not dcd's artifacts.zip: zipping
 * would need a zip implementation in a bundle whose whole point is having no
 * dependencies, and a directory is what a pipeline consumes next anyway. This
 * difference is called out explicitly in the migration table - it is the one
 * place our flag means something different rather than nothing. */
export const DEFAULT_ARTIFACTS_PATH = "./artifacts";

const list = (value: string): string[] =>
  value.split(",").map((s) => s.trim()).filter(Boolean);

export function parseCloud(argv: string[]): CloudOptions {
  const o: CloudOptions = {
    flowsPath: "",
    envPairs: [],
    requiredDeviceTags: [],
    isolation: "disabled",
    includeTags: [],
    excludeTags: [],
    excludeFlows: [],
    async: false,
    quiet: false,
    json: false,
    jsonFile: false,
    dryRun: false,
    artifactsPath: DEFAULT_ARTIFACTS_PATH,
    debug: false,
  };
  const positional: string[] = [];
  let artifactsPathGiven = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} requires a value`);
      return v;
    };

    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }

    // Tier 2 is checked BEFORE tier 3, so a recognised-but-unsupported flag
    // never falls through to a did-you-mean that would suggest something
    // unrelated and send the user chasing the wrong fix.
    if (a in UNSUPPORTED) {
      throw new CliError(`${a} is not supported by this farm: ${UNSUPPORTED[a]}`);
    }

    switch (a) {
      case "--api-key": o.apiKey = next(); break;
      case "--url": o.url = next(); break;
      case "--org": {
        const raw = next();
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new CliError("--org must be a positive integer org id (see `deviceyard whoami`)");
        }
        o.org = value;
        break;
      }
      case "--app-file": o.appFile = next(); break;
      case "--flows": o.flowsPath = next(); break;
      case "--exclude-flows": o.excludeFlows.push(...list(next())); break;
      case "--include-tags": o.includeTags.push(...list(next())); break;
      case "--exclude-tags": o.excludeTags.push(...list(next())); break;
      case "--env": o.envPairs.push(next()); break;
      case "--device-tags": o.requiredDeviceTags.push(...next().split(',').map(tag => tag.trim())); break;
      case "--isolation": {
        try { o.isolation = parseIsolation(next()); }
        catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError(error instanceof Error ? error.message : "Invalid isolation");
        }
        break;
      }
      case "--name": o.name = next(); break;
      case "--async": o.async = true; break;
      case "--quiet": case "-q": o.quiet = true; break;
      case "--json": o.json = true; break;
      case "--json-file": o.jsonFile = true; break;
      case "--json-file-name": o.jsonFileName = next(); break;
      case "--dry-run": o.dryRun = true; break;
      case "--junit-path": o.junitPath = next(); break;
      case "--debug": o.debug = true; break;
      case "--artifacts-path":
        o.artifactsPath = next();
        artifactsPathGiven = true;
        break;
      case "--report": {
        const value = next();
        if (value !== "junit") {
          throw new CliError(
            `only --report junit is supported; "${value}" is not. Generate HTML or Allure ` +
            `reports from the JUnit output, or from --json-file, in your own pipeline.`,
          );
        }
        o.report = "junit";
        break;
      }
      case "--download-artifacts": {
        const value = next().toUpperCase();
        if (value !== "ALL" && value !== "FAILED") {
          throw new CliError("--download-artifacts takes ALL or FAILED");
        }
        o.downloadArtifacts = value;
        break;
      }
      default: {
        const near = nearest(a, KNOWN_OPTIONS);
        throw new CliError(`unknown option "${a}"${near ? ` - did you mean "${near}"?` : ""}`);
      }
    }
  }

  if (positional[0]) o.appFilePositional = positional[0];
  if (positional[1] && !o.flowsPath) o.flowsPath = positional[1];

  if (o.jsonFileName && !o.jsonFile) throw new CliError("--json-file-name requires --json-file");
  if (o.junitPath && o.report !== "junit") throw new CliError("--junit-path requires --report junit");
  if (artifactsPathGiven && !o.downloadArtifacts) {
    throw new CliError("--artifacts-path requires --download-artifacts");
  }
  if (!o.appFile && !o.appFilePositional) {
    throw new CliError("an app file is required: deviceyard cloud <app-file> <flows-dir>");
  }
  if (!o.flowsPath) {
    throw new CliError("a flows path is required: deviceyard cloud <app-file> <flows-dir>");
  }

  try { o.requiredDeviceTags = parseDeviceTags(o.requiredDeviceTags); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : 'Invalid device tags'); }
  return o;
}

/** The read commands (status / list / artifacts) share a small flag set. They
 * do not reuse parseCloud, which would demand an app file and a flows path
 * neither of them has. Each helper throws CliError naming the flag, exactly
 * as parseCloud does. */
export interface ReadOptions {
  apiKey?: string;
  url?: string;
  org?: number;
  limit: number;
  downloadArtifacts: "ALL" | "FAILED";
  artifactsPath: string;
  positional: string[];
}

export function parseRead(argv: string[]): ReadOptions {
  const o: ReadOptions = {
    limit: 50,
    downloadArtifacts: "ALL",
    artifactsPath: DEFAULT_ARTIFACTS_PATH,
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} requires a value`);
      return v;
    };

    if (!a.startsWith("-")) {
      o.positional.push(a);
      continue;
    }

    if (a in UNSUPPORTED) {
      throw new CliError(`${a} is not supported by this farm: ${UNSUPPORTED[a]}`);
    }

    switch (a) {
      case "--api-key": o.apiKey = next(); break;
      case "--url": o.url = next(); break;
      case "--artifacts-path": o.artifactsPath = next(); break;
      case "--org": {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) {
          throw new CliError("--org must be a positive integer org id (see `deviceyard whoami`)");
        }
        o.org = value;
        break;
      }
      case "--limit": {
        const value = Number(next());
        // GET /api/jobs clamps to 1-200 server-side; rejecting here means a
        // typo is reported as a typo rather than silently clamped.
        if (!Number.isInteger(value) || value < 1 || value > 200) {
          throw new CliError("--limit must be an integer between 1 and 200");
        }
        o.limit = value;
        break;
      }
      case "--download-artifacts": {
        const value = next().toUpperCase();
        if (value !== "ALL" && value !== "FAILED") {
          throw new CliError("--download-artifacts takes ALL or FAILED");
        }
        o.downloadArtifacts = value;
        break;
      }
      default: {
        const near = nearest(a, [...KNOWN_OPTIONS, "--limit"]);
        throw new CliError(`unknown option "${a}"${near ? ` - did you mean "${near}"?` : ""}`);
      }
    }
  }

  return o;
}

export function requireJobId(o: ReadOptions, command: string): string {
  const id = o.positional[0];
  if (!id) throw new CliError(`a job id is required: deviceyard ${command} <job-id>`);
  return id;
}
