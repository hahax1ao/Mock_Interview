import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type StorageEnvironment = Partial<Record<"NODE_ENV" | "BAOYAN_DATA_DIR" | "LOCALAPPDATA" | "XDG_DATA_HOME" | "HOME", string>>;

export function resolveLocalStorageRoot(environment: StorageEnvironment = process.env, cwd = process.cwd()) {
  if (environment.BAOYAN_DATA_DIR) return resolve(/* turbopackIgnore: true */ cwd, environment.BAOYAN_DATA_DIR);
  if (environment.NODE_ENV === "test") return resolve(/* turbopackIgnore: true */ cwd, "data");

  const platformRoot = environment.LOCALAPPDATA
    ?? environment.XDG_DATA_HOME
    ?? (environment.HOME ? join(/* turbopackIgnore: true */ environment.HOME, ".local", "share") : null);
  return platformRoot ? resolve(/* turbopackIgnore: true */ platformRoot, "BaoyanInterviewAgent")
    : resolve(/* turbopackIgnore: true */ cwd, "data");
}

export function migrateLegacyDatabase(source: string, target: string) {
  if (!existsSync(/* turbopackIgnore: true */ source) || existsSync(/* turbopackIgnore: true */ target)) return false;
  mkdirSync(dirname(/* turbopackIgnore: true */ target), { recursive: true });
  const suffixes = ["", "-wal", "-shm"].filter((suffix) => existsSync(/* turbopackIgnore: true */ `${source}${suffix}`));
  const temporary = (suffix: string) => `${target}${suffix}.migrating`;
  for (const suffix of ["-wal", "-shm"]) rmSync(/* turbopackIgnore: true */ `${target}${suffix}`, { force: true });
  try {
    for (const suffix of suffixes) copyFileSync(/* turbopackIgnore: true */ `${source}${suffix}`, temporary(suffix));
    for (const suffix of ["-wal", "-shm", ""]) {
      if (suffixes.includes(suffix)) renameSync(/* turbopackIgnore: true */ temporary(suffix), `${target}${suffix}`);
    }
    return true;
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(/* turbopackIgnore: true */ temporary(suffix), { force: true });
      rmSync(/* turbopackIgnore: true */ `${target}${suffix}`, { force: true });
    }
    throw error;
  }
}
