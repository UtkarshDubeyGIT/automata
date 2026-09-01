const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function fieldMatches(source: string, value: number, minimum: number, maximum: number): boolean {
  return source.split(",").some((part) => {
    const [rangeSource, stepSource] = part.split("/");
    const step = stepSource ? Number(stepSource) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let start = minimum;
    let end = maximum;
    if (rangeSource !== "*") {
      if (rangeSource.includes("-")) {
        const bounds = rangeSource.split("-").map(Number);
        [start, end] = bounds;
      } else {
        start = Number(rangeSource);
        end = start;
      }
    }
    return Number.isInteger(start) && Number.isInteger(end) && start >= minimum && end <= maximum && value >= start && value <= end && (value - start) % step === 0;
  });
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { minute: Number(value("minute")), hour: Number(value("hour")), day: Number(value("day")), month: Number(value("month")), weekday: DOW[value("weekday")] };
}

export function nextCronOccurrence(expression: string, timezone: string, after = new Date()): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression must contain five fields.");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  let candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate = new Date(candidate.getTime() + 60_000);

  for (let checked = 0; checked < 527_040; checked += 1) {
    const local = zonedParts(candidate, timezone);
    const dayMatches = fieldMatches(dayOfMonth, local.day, 1, 31);
    const weekMatches = fieldMatches(dayOfWeek, local.weekday, 0, 6);
    const calendarMatches = dayOfMonth === "*" || dayOfWeek === "*" ? dayMatches && weekMatches : dayMatches || weekMatches;
    if (fieldMatches(minute, local.minute, 0, 59) && fieldMatches(hour, local.hour, 0, 23) && fieldMatches(month, local.month, 1, 12) && calendarMatches) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error("Cron expression has no occurrence in the next year.");
}
