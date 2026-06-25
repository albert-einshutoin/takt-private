export interface TimestampFormatOptions {
  timezone?: string;
}

type TimestampParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

const DEFAULT_TIMESTAMP_TIMEZONE = 'UTC';

export function isValidTimestampTimezone(timezone: string): boolean {
  if (timezone === 'local') {
    return true;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveIntlTimezone(timezone: string | undefined): string | undefined {
  if (timezone === 'local') {
    return undefined;
  }
  return timezone ?? DEFAULT_TIMESTAMP_TIMEZONE;
}

function getTimestampParts(date: Date, options: TimestampFormatOptions = {}): TimestampParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveIntlTimezone(options.timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: parts.year ?? '0000',
    month: parts.month ?? '00',
    day: parts.day ?? '00',
    hour: parts.hour ?? '00',
    minute: parts.minute ?? '00',
    second: parts.second ?? '00',
  };
}

export function formatTimestampForFilename(
  date: Date,
  options: TimestampFormatOptions = {},
): string {
  const parts = getTimestampParts(date, options);
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

export function formatShortTimestampForDisplay(
  isoString: string,
  options: TimestampFormatOptions = {},
): string {
  const parts = getTimestampParts(new Date(isoString), options);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
