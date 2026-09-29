const setting = {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

const formatter = new Intl.DateTimeFormat("en-CA", setting);

export function format(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const parts = formatter.formatToParts(date);
  const entries = parts.map((part) => [part.type, part.value]);
  const fields = Object.fromEntries(entries);
  const { year, month, day, hour, minute, second } = fields;
  const text = `${year}-${month}-${day} ${hour}:${minute}:${second}`;

  return text;
}

export function journal(line) {
  const match = line.match(
    new RegExp(
      [
        "^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z",
        "[+-]\\d{2}:?\\d{2}))(\\s.*)$",
      ].join("|"),
      "",
    ),
  );

  if (!match) {
    return line;
  }

  const stamp = format(match[1]);

  let result;

  if (stamp) {
    result = stamp + match[2];
  } else {
    result = line;
  }

  return result;
}
