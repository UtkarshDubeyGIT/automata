import type { ToolSpec } from "./registry";

export type ArgumentOption = { value: string | boolean | number; label: string };

function hintExamples(tool: ToolSpec): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tool.argHint);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Only schema-declared finite values get a picker. Everything else remains editable text. */
export function argumentOptions(tool: ToolSpec, key: string): ArgumentOption[] {
  const properties = tool.inputSchema?.properties;
  const property = properties && typeof properties === "object"
    ? (properties as Record<string, Record<string, unknown>>)[key]
    : undefined;
  const declared = property?.enum;
  if (Array.isArray(declared)) {
    return declared.filter((item): item is string | boolean | number =>
      typeof item === "string" || typeof item === "boolean" || typeof item === "number")
      .map((item) => ({ value: item, label: typeof item === "boolean" ? item ? "Yes" : "No" : String(item).replace(/_/g, " ") }));
  }
  if (property?.type === "boolean") return [{ value: true, label: "Yes" }, { value: false, label: "No" }];
  if (typeof hintExamples(tool)[key] === "boolean") return [{ value: true, label: "Yes" }, { value: false, label: "No" }];
  return [];
}

export function optionalChoiceKeys(tool: ToolSpec): string[] {
  const properties = tool.inputSchema?.properties;
  const schemaKeys = properties && typeof properties === "object" ? Object.keys(properties) : [];
  return [...new Set([...schemaKeys, ...Object.keys(hintExamples(tool))])]
    .filter((key) => !tool.required.includes(key) && argumentOptions(tool, key).length > 0);
}
