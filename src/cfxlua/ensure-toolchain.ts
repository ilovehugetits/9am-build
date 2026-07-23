import path from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";

const CFXLUA_VERSION = "v1.1.0";

export type CfxLuaToolchain = {
  vm: string;
  runtimeDir: string;
  version: string;
  viaWsl?: boolean;
};

function cacheRoot(): string {
  return (
    process.env.NINEAM_CFXLUA_CACHE ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".9am-build", "cfxlua")
  );
}

function downloadUrl(key: "windows" | "linux"): string {
  if (key === "windows") {
    return `https://github.com/VIRUXE/cfxlua-cli/releases/download/${CFXLUA_VERSION}/cfxlua-cli-windows.zip`;
  }
  return `https://github.com/VIRUXE/cfxlua-cli/releases/download/${CFXLUA_VERSION}/cfxlua-cli-linux.tar.gz`;
}

async function wslAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const proc = Bun.spawn(["wsl", "--status"], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return code === 0;
}

export function toWslPath(winPath: string): string {
  const normalized = path.resolve(winPath).replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/?(.*)$/);
  if (!match) return normalized;
  const tail = match[2] ? `/${match[2]}` : "";
  return `/mnt/${match[1].toLowerCase()}${tail}`;
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const proc = Bun.spawn(
        [
          "powershell",
          "-NoProfile",
          "-Command",
          `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`Failed to extract CfxLua archive: ${err}`);
      }
      return;
    }
    const proc = Bun.spawn(["unzip", "-o", archivePath, "-d", destDir], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Failed to extract CfxLua archive: ${err}`);
    }
    return;
  }

  await mkdir(destDir, { recursive: true });
  const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", destDir], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Failed to extract CfxLua archive: ${err}`);
  }
}

async function downloadToolchain(destDir: string, key: "windows" | "linux"): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const url = downloadUrl(key);
  const ext = url.endsWith(".zip") ? ".zip" : ".tar.gz";
  const archivePath = path.join(destDir, `cfxlua-cli${ext}`);

  console.log(`[9am-build] Downloading CfxLua ${CFXLUA_VERSION} (${key})...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download CfxLua toolchain (${res.status}): ${url}`);
  }
  await Bun.write(archivePath, res);
  await extractArchive(archivePath, destDir);
}

async function probeNativeVm(vm: string, runtimeDir: string): Promise<boolean> {
  const bootstrap = path.join(runtimeDir, "bootstrap.lua");
  const probeScript = path.join(runtimeDir, ".9am-probe.lua");
  await Bun.write(probeScript, 'print("9AM_CFXLUA_PROBE_OK")\n');

  const proc = Bun.spawn([vm, bootstrap, probeScript], {
    cwd: path.dirname(vm),
    env: {
      ...process.env,
      PATH: `${path.dirname(vm)}${path.delimiter}${process.env.PATH ?? ""}`,
      CFXLUA_TIMEOUT: "3000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 && stdout.includes("9AM_CFXLUA_PROBE_OK");
}

function resolveFromEnv(): CfxLuaToolchain | null {
  const vm = process.env.CFXLUA_VM;
  const runtimeDir = process.env.CFXLUA_RUNTIME;
  if (!vm || !runtimeDir) return null;
  if (!existsSync(vm)) throw new Error(`CFXLUA_VM not found: ${vm}`);
  if (!existsSync(path.join(runtimeDir, "bootstrap.lua"))) {
    throw new Error(`CFXLUA_RUNTIME missing bootstrap.lua: ${runtimeDir}`);
  }
  return { vm, runtimeDir, version: "custom" };
}

async function ensurePlatformToolchain(key: "windows" | "linux"): Promise<CfxLuaToolchain> {
  const destDir = path.join(cacheRoot(), CFXLUA_VERSION, key);
  const vm = path.join(destDir, key === "windows" ? "cfxlua-vm.exe" : "cfxlua-vm");
  const runtimeDir = path.join(destDir, "runtime");

  if (!existsSync(vm) || !existsSync(path.join(runtimeDir, "bootstrap.lua"))) {
    await downloadToolchain(destDir, key);
  }

  if (!existsSync(vm)) {
    throw new Error(`CfxLua VM not found after download: ${vm}`);
  }
  if (!existsSync(path.join(runtimeDir, "bootstrap.lua"))) {
    throw new Error(`CfxLua runtime not found after download: ${runtimeDir}`);
  }

  return { vm, runtimeDir, version: CFXLUA_VERSION };
}

export async function ensureCfxLuaToolchain(): Promise<CfxLuaToolchain> {
  const fromEnv = resolveFromEnv();
  if (fromEnv) return fromEnv;

  if (process.platform === "linux") {
    return ensurePlatformToolchain("linux");
  }

  if (process.platform === "win32") {
    const native = await ensurePlatformToolchain("windows");
    if (await probeNativeVm(native.vm, native.runtimeDir)) {
      return native;
    }

    if (await wslAvailable()) {
      const linux = await ensurePlatformToolchain("linux");
      console.log(chalkFallbackNotice());
      return { ...linux, viaWsl: true };
    }

    throw new Error(
      "CfxLua VM failed to start on Windows and WSL is unavailable.\n" +
        "Install WSL (`wsl --install`) or set CFXLUA_VM / CFXLUA_RUNTIME to a working toolchain."
    );
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function chalkFallbackNotice(): string {
  return "Native CfxLua VM unavailable — using Linux binary via WSL.";
}

export function packageRoot(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

export function testAssetsDir(): string {
  return path.join(packageRoot(), "src", "cfxlua", "test");
}
