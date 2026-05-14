export type Semver = {
  major: number;
  minor: number;
  patch: number;
};

export type RuntimeDetails = {
  kind: "node" | "unknown";
  version: string | null;
  execPath: string | null;
  pathEnv: string;
};

const MINIMUM_SUPPORTED_NODE: Semver = { major: 18, minor: 0, patch: 0 };
const MAXIMUM_WARNING_NODE: Semver = { major: 22, minor: 0, patch: 0 };

export function parseSemver(version: string | null): Semver | null {
  if (!version) {
    return null;
  }

  // Strip leading 'v' if present
  const cleaned = version.startsWith("v") ? version.slice(1) : version;
  const parts = cleaned.split(".");

  if (parts.length < 3) {
    return null;
  }

  const majorStr = parts[0];
  const minorStr = parts[1];
  const patchStr = parts[2];
  
  if (!majorStr || !minorStr || !patchStr) {
    return null;
  }
  
  const major = parseInt(majorStr, 10);
  const minor = parseInt(minorStr, 10);
  const patch = parseInt(patchStr, 10);

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return null;
  }

  return { major, minor, patch };
}

export function isAtLeast(version: Semver | null, minimum: Semver): boolean {
  if (!version) {
    return false;
  }

  if (version.major > minimum.major) {
    return true;
  }
  if (version.major < minimum.major) {
    return false;
  }

  if (version.minor > minimum.minor) {
    return true;
  }
  if (version.minor < minimum.minor) {
    return false;
  }

  return version.patch >= minimum.patch;
}

export function detectRuntime(): RuntimeDetails {
  if (typeof process !== "undefined" && process.versions?.node) {
    let version: string | null = null;
    let execPath: string | null = null;
    let pathEnv = "";
    
    if (typeof process.version === "string") {
      version = process.version;
    }
    
    if (typeof process.execPath === "string") {
      execPath = process.execPath;
    }
    
    if (typeof process.env.PATH === "string") {
      pathEnv = process.env.PATH;
    }
    
    return {
      kind: "node",
      version,
      execPath,
      pathEnv,
    };
  }

  return {
    kind: "unknown",
    version: null,
    execPath: null,
    pathEnv: "",
  };
}

export function isSupportedNodeVersion(version: string | null): boolean {
  const parsed = parseSemver(version);
  return isAtLeast(parsed, MINIMUM_SUPPORTED_NODE);
}

export function assertSupportedRuntime(): void {
  const runtime = detectRuntime();
  
  if (runtime.kind !== "node") {
    throw new Error(
      "openplaw requires Node.js runtime to run. Current runtime is unknown."
    );
  }

  if (!isSupportedNodeVersion(runtime.version)) {
    throw new Error(
      `openplaw requires Node.js version >= ${MINIMUM_SUPPORTED_NODE.major}.${MINIMUM_SUPPORTED_NODE.minor}.${MINIMUM_SUPPORTED_NODE.patch}. ` +
      `Current version: ${runtime.version}. ` +
      "Please upgrade your Node.js installation."
    );
  }

  const parsed = parseSemver(runtime.version);
  if (parsed && parsed.major > MAXIMUM_WARNING_NODE.major) {
    console.warn(
      `WARNING: You are using Node.js version ${runtime.version}, which is newer than the latest tested version (${MAXIMUM_WARNING_NODE.major}.x). ` +
      "Everything should work, but if you encounter issues, please report them."
    );
  }
}
