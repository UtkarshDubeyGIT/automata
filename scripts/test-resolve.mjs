import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"];

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function locate(base) {
  if (isFile(base)) return base;
  for (const extension of EXTENSIONS) {
    if (isFile(base + extension)) return base + extension;
  }
  for (const extension of EXTENSIONS) {
    const index = path.join(base, `index${extension}`);
    if (isFile(index)) return index;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let absolute = null;
  if (specifier.startsWith("@/")) {
    absolute = path.join(ROOT, "src", specifier.slice(2));
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    absolute = fileURLToPath(new URL(specifier, context.parentURL));
  }

  if (absolute) {
    const found = locate(absolute);
    if (found) return nextResolve(pathToFileURL(found).href, context);
    if (!existsSync(absolute)) throw new Error(`Cannot resolve '${specifier}' from ${context.parentURL ?? "<entry>"}`);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && !specifier.endsWith(".js")) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
