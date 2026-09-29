import { stripVTControlCharacters } from "node:util";
import * as color from "#cli/view/color.js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const glyphs = {
  horizontal: "─",
  vertical: "│",
  top: "┌",
  bottom: "└",
  right: "┐",
  end: "┘",
  down: "┬",
  up: "┴",
  left: "├",
  side: "┤",
  cross: "┼",
  rounded: "╭",
  corner: "╮",
  base: "╰",
  finish: "╯",
};

const ranges = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

function wide(code) {
  const output = ranges.some(function contains([minimum, maximum]) {
    let result = code >= minimum;

    if (result) {
      result = code <= maximum;
    }

    return result;
  });

  return output;
}

function clean(value) {
  const text = stripVTControlCharacters(String(value ?? ""));

  return text.replace(/\p{Cc}/gu, "");
}

const patterns = [
  "\\p{Extended_Pictographic}",
  "\\p{Regional_Indicator}",
  "\\uFE0F",
  "\\u20E3",
];

const pictographic = new RegExp(patterns.join("|"), "u");

function size(text) {
  if (pictographic.test(text)) {
    return 2;
  }

  const points = [...text].filter(function visible(point) {
    const valid = !/\p{Mark}/u.test(point);

    return valid;
  });

  if (!points.length) {
    return 0;
  }

  const code = points[0].codePointAt(0);

  if (wide(code)) {
    return 2;
  }

  return 1;
}

export function width(value) {
  let total = 0;

  for (const part of segments.segment(clean(value))) {
    total += size(part.segment);
  }

  return total;
}

export function center(value, length) {
  const text = clean(value);
  const padding = Math.max(0, length - width(text));
  const before = Math.floor(padding / 2);
  const leading = " ".repeat(before);
  const trailing = " ".repeat(padding - before);
  const result = leading + text + trailing;

  return result;
}

export function clip(value, length) {
  const text = clean(value);

  if (width(text) <= length) {
    return text;
  }

  let result = "";

  for (const part of segments.segment(text)) {
    if (width(result) + size(part.segment) > length - 1) {
      break;
    }

    result += part.segment;
  }

  const output = result + "…";

  return output;
}

export function span(columns = process.stdout.columns ?? 80) {
  let value = Number.isFinite(columns);

  if (value) {
    value = columns > 0;
  }

  let available;

  if (value) {
    available = columns;
  } else {
    available = 80;
  }

  const result = Math.max(6, Math.min(64, available));

  return result;
}

export function border(value, option = {}) {
  const length = option.length ?? width(value);

  let offset = option.offset ?? 0;

  const lines = new Set(Object.values(glyphs));

  const result = Array.from(segments.segment(value), function paint(part) {
    const piece = part.segment;
    const setting = { offset, length };

    let text;

    if (lines.has(piece)) {
      text = color.gradient(piece, setting);
    } else {
      text = piece;
    }

    offset += size(piece);

    return text;
  }).join("");

  return result;
}

export function frame(title, option = {}) {
  const { columns = process.stdout.columns ?? 80 } = option;
  const length = span(columns);
  const content = length - 4;
  const caption = clip(title, length - 6);

  let label;

  if (caption) {
    label = ` ${caption} `;
  } else {
    label = "";
  }

  const remainder = length - 2 - width(label);
  const before = Math.floor(remainder / 2);
  const after = remainder - before;
  const line = glyphs.horizontal.repeat(length - 2);
  const prefix = glyphs.rounded + glyphs.horizontal.repeat(before);
  const suffix = glyphs.horizontal.repeat(after) + glyphs.corner;
  const top = prefix + label + suffix;
  const bottom = glyphs.base + line + glyphs.finish;
  const divide = glyphs.left + line + glyphs.side;

  function parts(value) {
    const text = clip(value, content);
    const padding = " ".repeat(content - width(text));
    const setting = { length };
    const right = { offset: length - 1, length };
    const prefix = border(glyphs.vertical, setting) + " ";
    const ending = " " + border(glyphs.vertical, right);
    const suffix = padding + ending;
    const result = { text, prefix, suffix, padding, ending };

    return result;
  }

  function row(value, format = String) {
    const cell = parts(value);
    const text = cell.prefix + format(cell.text + cell.padding) + cell.ending;

    return text;
  }

  function highlight(value) {
    const cell = parts(value);
    const text = " " + cell.text + cell.padding + " ";
    const setting = { length };
    const ending = { offset: length - 1, length };
    const prefix = border(glyphs.vertical, setting);
    const selected = color.highlight(text);
    const suffix = border(glyphs.vertical, ending);
    const result = prefix + selected + suffix;

    return result;
  }

  const output = {
    top,
    bottom,
    divide,
    content,
    parts,
    row,
    highlight,
    length,
  };

  return output;
}

export function table(headers, rows, option = {}) {
  const {
    columns = process.stdout.columns ?? 80,
    states = [],
    rounded = false,
  } = option;

  const titled = headers !== null;
  const result = headers ?? rows[0];
  const labels = result ?? [];

  let data;

  if (titled) {
    data = [headers, ...rows];
  } else {
    data = rows;
  }

  const lengths = labels.map(function length(header, index) {
    const heading = width(header);

    const cells = rows.map(function cell(row) {
      return width(row[index]);
    });

    const maximum = Math.max(heading, ...cells);
    const text = maximum + 2;

    return text;
  });

  const minimum = labels.map(function length(header, index) {
    let identity = labels.length === 5;

    if (identity) {
      identity = [0, 2, 4].includes(index);
    }

    if (!identity) {
      return 3;
    }

    const values = rows.map((row) => {
      const text = width(row[index]) + 2;

      return text;
    });

    return Math.max(3, ...values);
  });

  const available = span(columns);

  const required = minimum.reduce((total, length) => {
    const text = total + length;

    return text;
  }, minimum.length + 1);

  if (required > available) {
    const entries = data.map(function entry(row, index) {
      let position;

      if (titled) {
        position = index - 1;
      } else {
        position = index;
      }

      const selected = position === option.selected;

      let format;

      if (selected) {
        format = color.highlight;
      } else {
        format = String;
      }

      const text = row.join(" ");
      const values = [text];
      const formats = [format];
      const result = { values, formats, align: "left" };

      return result;
    });

    const positions = [];
    const setting = { positions, rounded, heading: titled };
    const lines = grid(entries, [available - 2], setting);

    option.positions?.push(...positions);

    return lines.join("\n");
  }

  let total = lengths.reduce(function sum(total, length) {
    const text = total + length;

    return text;
  }, lengths.length + 1);

  while (total > available) {
    let index = -1;

    for (let position = 0; position < lengths.length; position++) {
      const space = lengths[position] > minimum[position];

      let largest = index < 0;

      if (!largest) {
        largest = lengths[position] > lengths[index];
      }

      if (space && largest) {
        index = position;
      }
    }

    if (index < 0) {
      break;
    }

    lengths[index]--;

    total--;
  }

  const desired = Math.max(total, available);

  for (let index = 0; ; index++) {
    let report = total < desired;

    if (report) {
      report = lengths.length;
    }

    if (!report) {
      break;
    }

    lengths[index % lengths.length]++;

    total++;
  }

  const entries = data.map(function entry(values, index) {
    let equal;

    if (titled) {
      equal = index === 0;
    }

    const heading = titled && equal;

    let row;

    if (titled) {
      row = index - 1;
    } else {
      row = index;
    }

    const formats = values.map(function format(_, position) {
      if (heading) {
        return color.dim;
      }

      let valid = position === 0;

      if (valid) {
        valid = row === option.selected;
      }

      if (valid) {
        return color.highlight;
      }

      if (option.formats?.[position]) {
        return option.formats[position];
      }

      if (position === 1) {
        const report = (value) => color.state(value, states[row]);

        return report;
      }

      return String;
    });

    const result = { values, formats };

    return result;
  });

  const positions = option.positions;
  const setting = { positions, rounded, heading: titled };
  const valid = grid(entries, lengths, setting).join("\n");

  return valid;
}

export function grid(rows, lengths, option = {}) {
  const length = lengths.reduce((total, value) => {
    const text = total + value;

    return text;
  }, lengths.length + 1);

  let column = 0;

  const joints = lengths.slice(0, -1).map(function joint(value) {
    column += value + 1;

    return column;
  });

  const rounded = option.rounded ?? true;
  const opening = { edge: "top", below: joints, rounded };
  const closing = { edge: "bottom", above: joints, rounded };
  const divide = { above: joints, below: joints };
  const lines = [section(length, opening)];

  for (const [index, row] of rows.entries()) {
    if (index) {
      lines.push(section(length, divide));
    }

    let valid = !option.heading;

    if (!valid) {
      valid = index;
    }

    if (valid) {
      option.positions?.push(lines.length);
    }

    lines.push(cells(row.values, lengths, row));
  }

  lines.push(section(length, closing));

  return lines;
}

export function section(length, option = {}) {
  const above = new Set(option.above ?? []);
  const below = new Set(option.below ?? []);
  const edge = option.edge;
  const rounded = option.rounded !== false;

  let top;

  if (rounded) {
    top = [glyphs.rounded, glyphs.corner];
  } else {
    top = [glyphs.top, glyphs.right];
  }

  let bottom;

  if (rounded) {
    bottom = [glyphs.base, glyphs.finish];
  } else {
    bottom = [glyphs.bottom, glyphs.end];
  }

  let left;

  if (edge === "top") {
    left = top[0];
  } else if (edge === "bottom") {
    left = bottom[0];
  } else {
    left = glyphs.left;
  }

  let right;

  if (edge === "top") {
    right = top[1];
  } else if (edge === "bottom") {
    right = bottom[1];
  } else {
    right = glyphs.side;
  }

  const pieces = [left];

  for (let column = 1; column < length - 1; column++) {
    const top = above.has(column);
    const bottom = below.has(column);

    let symbol = glyphs.horizontal;

    if (top && bottom) {
      symbol = glyphs.cross;
    } else if (top) {
      symbol = glyphs.up;
    } else if (bottom) {
      symbol = glyphs.down;
    }

    pieces.push(symbol);
  }

  pieces.push(right);

  const result = border(pieces.join(""));

  return result;
}

export function cells(values, lengths, option = {}) {
  const length = lengths.reduce((total, value) => {
    const text = total + value;

    return text;
  }, lengths.length + 1);

  let column = 0;
  let result = border(glyphs.vertical, { length });

  for (const [index, value] of values.entries()) {
    const available = Math.max(0, lengths[index] - 2);

    let clipped;

    if (available) {
      clipped = clip(value, available);
    } else {
      clipped = "";
    }

    let centered;

    if (option.align === "left") {
      const padding = " ".repeat(lengths[index] - width(clipped) - 1);

      centered = " " + clipped + padding;
    } else {
      centered = center(clipped, lengths[index]);
    }

    const format = option.formats?.[index] ?? String;

    result += format(centered);
    column += lengths[index] + 1;

    const setting = { length, offset: column };

    result += border(glyphs.vertical, setting);
  }

  return result;
}

export function wrap(value, length, option = {}) {
  if (option.words) {
    return words(value, length, option);
  }

  const lines = [];

  let text = "";

  for (const part of segments.segment(clean(value))) {
    const piece = part.segment;

    let valid = text;

    if (valid) {
      valid = width(text + piece) > length;
    }

    if (valid) {
      lines.push(text);

      text = "";
    }

    text += piece;
  }

  lines.push(text);

  return lines;
}

function words(value, length, option) {
  const tokens = clean(value).match(/\S+/gu) ?? [];
  const longest = Math.max(1, ...tokens.map(width));
  const prefix = clean(option.prefix ?? "");
  const indentation = Math.min(width(prefix), Math.max(0, length - longest));
  const padding = " ".repeat(indentation);

  let lines;

  if (width(prefix) > length) {
    lines = words(prefix, length, {});
  } else {
    lines = [];
  }

  let text;

  if (lines.length) {
    text = padding;
  } else {
    text = prefix;
  }

  for (const token of tokens) {
    let absent;

    if (text) {
      absent = !text.endsWith(" ");
    }

    const checked = text && absent;

    let separator;

    if (checked) {
      separator = " ";
    } else {
      separator = "";
    }

    if (width(text + separator + token) <= length) {
      text += separator + token;

      continue;
    }

    if (text.trim()) {
      lines.push(text.trimEnd());
    }

    if (width(token) > length) {
      const pieces = wrap(token, length);

      lines.push(...pieces.slice(0, -1));

      text = pieces.at(-1);
    } else {
      text = padding + token;
    }
  }

  if (text.trim()) {
    lines.push(text.trimEnd());
  }

  return lines;
}
