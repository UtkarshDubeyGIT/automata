const UTC = "UTC";

function parts(now: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: UTC,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
}

export function todayLabel(now: Date = new Date()): string {
  const p = parts(now);
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}

export function currentPeriodLabel(now: Date = new Date()): string {
  const p = parts(now);
  return `${p.month} ${p.year}`;
}

export function currentYear(now: Date = new Date()): string {
  return parts(now).year;
}

export function todayContext(now: Date = new Date()): string {
  const p = parts(now);
  return [
    "\n--- TODAY ---",
    `Today's date is ${todayLabel(now)}. The current month is ${p.month} ${p.year} and the current year is ${p.year}.`,
    `Your training data ends before this. Treat anything you "remember" as potentially out of date, and rely on the research provided below for anything time-sensitive.`,
    `When you refer to a date, write the real date — never a placeholder such as "[current date]", "today's date", "TBD" or an empty string.`,
    "---",
  ].join("\n");
}
