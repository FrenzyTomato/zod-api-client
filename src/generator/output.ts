import { access, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import type { RenderedFile } from "./render-schemas.js";

export const MARKER_FILE = ".zod-api-client.json";

export interface OutputMarker {
  generator: "zod-api-client";
  version: string;
  inputHash: string;
  ownedFiles: string[];
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const readMarker = async (output: string): Promise<OutputMarker | undefined> => {
  const markerPath = path.join(output, MARKER_FILE);
  if (!(await exists(markerPath))) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read generator marker ${markerPath}`, { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<OutputMarker>).generator !== "zod-api-client" ||
    typeof (value as Partial<OutputMarker>).version !== "string" ||
    typeof (value as Partial<OutputMarker>).inputHash !== "string" ||
    !Array.isArray((value as Partial<OutputMarker>).ownedFiles) ||
    !(value as Partial<OutputMarker>).ownedFiles?.every((file) => typeof file === "string")
  ) {
    throw new Error(`Invalid generator marker ${markerPath}`);
  }
  return value as OutputMarker;
};

const assertRelativeFile = (file: string): void => {
  if (path.isAbsolute(file) || file === "" || file.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe generated file path ${JSON.stringify(file)}`);
  }
};

const assertSafeOutputPath = async (root: string, relativeFile: string): Promise<void> => {
  assertRelativeFile(relativeFile);
  let current = root;
  for (const component of relativeFile.split(/[\\/]/)) {
    current = path.join(current, component);
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (currentStat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symbolic link in generated output path ${current}`);
    }
  }
};

const atomicWrite = async (target: string, content: string): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
};

const removeEmptyDirectory = async (directory: string, root: string): Promise<void> => {
  if (directory === root || !directory.startsWith(`${root}${path.sep}`)) return;
  try {
    if ((await readdir(directory)).length > 0) return;
    await rm(directory, { recursive: false });
    await removeEmptyDirectory(path.dirname(directory), root);
  } catch {
    // Another generated file may still own the directory.
  }
};

export const formatRenderedFiles = async (files: RenderedFile[]): Promise<RenderedFile[]> =>
  Promise.all(
    files.map(async (file) => {
      assertRelativeFile(file.path);
      return {
        ...file,
        content: await format(file.content, { parser: "typescript", printWidth: 120 }),
      };
    }),
  );

export const writeGeneratedOutput = async (
  output: string,
  files: RenderedFile[],
  marker: Omit<OutputMarker, "ownedFiles">,
): Promise<OutputMarker> => {
  const outputPath = path.resolve(output);
  await mkdir(outputPath, { recursive: true });
  const outputStat = await lstat(outputPath);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error(`Generated output root must be a real directory: ${outputPath}`);
  }
  await assertSafeOutputPath(outputPath, MARKER_FILE);
  const directoryEntries = await readdir(outputPath);
  const previousMarker = await readMarker(outputPath);
  if (directoryEntries.length > 0 && !previousMarker) {
    throw new Error(
      `Refusing to generate into non-empty directory ${outputPath} because it has no ${MARKER_FILE} ownership marker`,
    );
  }

  const previousOwned = new Set(previousMarker?.ownedFiles ?? []);
  for (const file of previousOwned) assertRelativeFile(file);
  const nextOwned = files.map((file) => file.path).sort();
  for (const file of nextOwned) {
    await assertSafeOutputPath(outputPath, file);
    const target = path.join(outputPath, file);
    if ((await exists(target)) && !previousOwned.has(file)) {
      throw new Error(`Refusing to overwrite unowned file ${target}`);
    }
    if (await exists(target)) {
      const targetStat = await stat(target);
      if (!targetStat.isFile()) throw new Error(`Generated output path is not a file: ${target}`);
    }
  }

  const nextMarker: OutputMarker = { ...marker, ownedFiles: nextOwned };
  const recoveryMarker: OutputMarker = {
    ...marker,
    ownedFiles: [...new Set([...previousOwned, ...nextOwned])].sort(),
  };
  await atomicWrite(path.join(outputPath, MARKER_FILE), `${JSON.stringify(recoveryMarker, undefined, 2)}\n`);

  for (const file of files) await atomicWrite(path.join(outputPath, file.path), file.content);

  for (const stale of [...previousOwned].filter((file) => !nextOwned.includes(file))) {
    await assertSafeOutputPath(outputPath, stale);
    const target = path.join(outputPath, stale);
    await rm(target, { force: true });
    await removeEmptyDirectory(path.dirname(target), outputPath);
  }

  await atomicWrite(path.join(outputPath, MARKER_FILE), `${JSON.stringify(nextMarker, undefined, 2)}\n`);
  return nextMarker;
};
