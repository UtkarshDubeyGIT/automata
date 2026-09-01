const SECRET_KEY = /(^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key)($|[_-])/i;
const COMPACT_SECRET_KEY = /^(access|refresh|id)?token$/i;
const MAX_STRING = 10_000;
const MAX_ITEMS = 100;
const MAX_DEPTH = 12;

export function redactForLog(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function visit(input: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
    if (typeof input === "string") return input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…[truncated]` : input;
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[CIRCULAR]";
    seen.add(input);

    if (Array.isArray(input)) {
      const items = input.slice(0, MAX_ITEMS).map((item) => visit(item, depth + 1));
      if (input.length > MAX_ITEMS) items.push({ truncated: input.length - MAX_ITEMS });
      return items;
    }

    return Object.fromEntries(Object.entries(input).map(([key, item]) => {
      const compact = key.replace(/[_-]/g, "");
      const secret = SECRET_KEY.test(key) || COMPACT_SECRET_KEY.test(compact);
      return [key, secret ? "[REDACTED]" : visit(item, depth + 1)];
    }));
  }

  return visit(value, 0);
}
