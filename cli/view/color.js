import { stripVTControlCharacters } from "node:util";

const tones = {
  accent: 37,
  dim: 2,
  info: 37,
  success: 32,
  warning: 33,
  error: 31,
  empty: 90,
};

const hues = {
  accent: [192, 192, 192],
  success: [0, 170, 0],
  warning: [235, 166, 87],
  error: [230, 135, 153],
  empty: [65, 72, 84],
};

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const palette = [
  [250, 250, 252],
  [210, 214, 220],
  [135, 142, 152],
  [65, 72, 84],
];

const negatives = new Set([
  "down",
  "disable",
  "disabled",
  "inactive",
  "closed",
  "stopped",
  "failed",
  "no",
  "unavailable",
  "unknown",
  "unconfigured",
  "unlinked",
  "error",
  "warning",
]);

function truecolor(stream) {
  const inherited = process.env.ORBIT_COLORS === "24";
  const detected = stream.hasColors?.(16777216) === true;
  const enabled = supported(stream);
  const capable = inherited || detected;
  const result = enabled && capable;

  return result;
}

export function supported(stream = process.stdout) {
  const disabled = process.env.NO_COLOR !== undefined;

  let terminal = stream.isTTY;

  if (terminal) {
    terminal = process.env.TERM !== "dumb";
  }

  let valid = disabled;

  if (!valid) {
    valid = !terminal;
  }

  if (valid) {
    return false;
  }

  let result = ["8", "24"].includes(process.env.ORBIT_COLORS);

  if (!result) {
    result = stream.hasColors?.(8) === true;
  }

  return result;
}

export function paint(value, tone, stream = process.stdout) {
  const text = String(value ?? "");
  const code = tones[tone];

  let valid = !code;

  if (!valid) {
    valid = !supported(stream);
  }

  if (valid) {
    return text;
  }

  let report = ["empty", "warning", "error"].includes(tone);

  if (report) {
    report = truecolor(stream);
  }

  if (report) {
    const rgb = hues[tone].join(";");
    const result = `\u001b[38;2;${rgb}m${text}\u001b[0m`;

    return result;
  }

  const available = `\u001b[${code}m${text}\u001b[0m`;

  return available;
}

function bright(value, tone, stream = process.stdout) {
  const text = String(value ?? "");

  if (!supported(stream)) {
    return text;
  }

  if (!truecolor(stream)) {
    const ordinary = tones[tone];

    let code;

    if (ordinary < 90) {
      code = ordinary + 60;
    } else {
      code = ordinary;
    }

    const result = `\u001b[${code}m${text}\u001b[0m`;

    return result;
  }

  const channels = hues[tone].map(function channel(value) {
    const distance = 255 - value;
    const result = Math.round(value + distance * 0.4);

    return result;
  });

  const rgb = channels.join(";");
  const result = `\u001b[38;2;${rgb}m${text}\u001b[0m`;

  return result;
}

export function gradient(value, option = {}) {
  const stream = option.stream ?? process.stdout;
  const text = String(value ?? "");

  if (!truecolor(stream)) {
    return paint(text, "accent", stream);
  }

  const pieces = Array.from(segments.segment(text), function piece(part) {
    return part.segment;
  });

  const length = option.length ?? pieces.length;
  const offset = option.offset ?? 0;
  const denominator = Math.max(length - 1, 1);

  const result = pieces
    .map(function foreground(piece, index) {
      const channels = shade(Math.min((index + offset) / denominator, 1));
      const rgb = channels.join(";");
      const text = `\u001b[38;2;${rgb}m${piece}\u001b[0m`;

      return text;
    })
    .join("");

  return result;
}

export function state(value, state, stream = process.stdout) {
  const success = ["ready", "active", "yes", "up"].includes(state);
  const failure = negatives.has(state);

  let tone = "dim";

  if (success) {
    tone = "success";
  } else if (failure) {
    tone = "error";
  }

  return paint(value, tone, stream);
}

function shade(ratio) {
  const position = ratio * (palette.length - 1);
  const stop = Math.min(Math.floor(position), palette.length - 2);
  const amount = position - stop;
  const start = palette[stop];
  const end = palette[stop + 1];

  const result = start.map(function channel(value, index) {
    const result = Math.round(value + (end[index] - value) * amount);

    return result;
  });

  return result;
}

function luminance(rgb) {
  const channels = rgb.map(function channel(value) {
    const level = value / 255;

    let result;

    if (level <= 0.04045) {
      result = level / 12.92;
    } else {
      result = ((level + 0.055) / 1.055) ** 2.4;
    }

    return result;
  });

  const red = channels[0] * 0.2126;
  const green = channels[1] * 0.7152;
  const blue = channels[2] * 0.0722;
  const text = red + green + blue;

  return text;
}

function contrast(rgb, dark) {
  let limit;

  if (dark) {
    limit = 0.175;
  } else {
    limit = 1.05 / 4.5 - 0.05;
  }

  let target;

  if (dark) {
    target = 255;
  } else {
    target = 0;
  }

  for (let step = 0; step <= 100; step++) {
    const ratio = step / 100;

    const channels = rgb.map((value) =>
      Math.round(value + (target - value) * ratio),
    );

    const light = luminance(channels);

    let matched;

    if (dark) {
      matched = light >= limit;
    } else {
      matched = light <= limit;
    }

    if (matched) {
      return channels;
    }
  }

  return rgb;
}

export function highlight(value, stream = process.stdout) {
  const text = stripVTControlCharacters(String(value ?? ""));

  if (!supported(stream)) {
    return text;
  }

  if (!truecolor(stream)) {
    const result = `\u001b[30;47m${text}\u001b[0m`;

    return result;
  }

  const pieces = Array.from(segments.segment(text), function piece(part) {
    return part.segment;
  });

  const denominator = Math.max(pieces.length - 1, 1);
  const dark = luminance(shade(0.5)) > 0.179;

  let ink;

  if (dark) {
    ink = "0;0;0";
  } else {
    ink = "255;255;255";
  }

  const prefix = `\u001b[38;2;${ink}m`;

  const body = pieces
    .map(function background(piece, index) {
      const channels = contrast(shade(index / denominator), dark);
      const rgb = channels.join(";");
      const text = `\u001b[48;2;${rgb}m${piece}`;

      return text;
    })
    .join("");

  const result = prefix + body + "\u001b[0m";

  return result;
}

export function selection(value, state, stream = process.stdout) {
  if (negatives.has(state)) {
    return paint(value, "error", stream);
  }

  return paint(value, "success", stream);
}

export function result(value, code, stream = process.stdout) {
  const success = ["preference", "complete"].includes(code);
  const warning = ["pending", "skipped", "changed", "mount"].includes(code);

  let tone = "error";

  if (success) {
    tone = "success";
  } else if (warning) {
    tone = "warning";
  }

  return paint(value, tone, stream);
}

export function history(value, option = {}) {
  const tones = {
    "+": "success",
    "!": "warning",
    x: "error",
    "-": "empty",
    ".": "accent",
  };

  const result = Array.from(value, function sample(character, index) {
    const tone = tones[character];

    if (!tone) {
      return character;
    }

    const selected = option.selected === index;

    let ordinary;

    if (supported()) {
      ordinary = "▌";
    } else {
      ordinary = character;
    }

    let symbol;

    if (selected) {
      symbol = "█";
    } else {
      symbol = ordinary;
    }

    if (selected) {
      return bright(symbol, tone);
    }

    return paint(symbol, tone);
  }).join("");

  return result;
}

export function dim(value) {
  return paint(value, "dim");
}
