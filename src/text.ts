/** "3 Nov 2026" in the given time zone. */
export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(date);
}

/** "2026-11-03" in the given time zone. */
export function isoDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(date);
}

export function splitLines(value: string | undefined): string[] {
  return value ? value.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

export function addressLines(parts: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | number | null;
  country?: string | null;
}): string[] {
  const country = parts.country && parts.country.length === 2 ? parts.country.toUpperCase() : parts.country;
  const cityLine = [[parts.city, parts.state].filter(Boolean).join(', '), parts.postalCode ? String(parts.postalCode) : '']
    .filter(Boolean)
    .join(' ');
  return [parts.line1, parts.line2, cityLine, country].filter((line): line is string => Boolean(line && line.trim()));
}
