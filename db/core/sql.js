export function statements(text) {
  const statements = [];

  let start = 0;
  let quote = null;
  let depth = 0;
  let line = false;
  let code = "";

  function append(end) {
    const words = code.trim().toUpperCase();

    const commands = [
      "BEGIN",
      "START",
      "COMMIT",
      "END",
      "ROLLBACK",
      "ABORT",
      "SAVEPOINT",
      "RELEASE",
      "PREPARE",
      "SET",
      "RESET",
      "DISCARD",
      "VACUUM",
    ];

    const expression = "^(?:" + commands.join("|") + ")\\b";
    const pattern = new RegExp(expression, "u");
    const control = pattern.test(words);

    if (control) {
      throw new Error(
        "MIGRATION_SQL: Transaction or session control is forbidden.",
      );
    }

    if (words) {
      const statement = text.slice(start, end).trim();

      statements.push(statement);
    }

    start = end + 1;
    code = "";
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    const pair = text.slice(index, index + 2);

    if (line) {
      if (char === "\n") {
        line = false;
        code += " ";
      }

      continue;
    }

    if (depth) {
      if (pair === "/*") {
        depth++;

        index++;
      } else if (pair === "*/") {
        depth--;

        index++;

        code += " ";
      }

      continue;
    }

    if (quote) {
      if (quote.startsWith("$")) {
        if (text.startsWith(quote, index)) {
          index += quote.length - 1;
          quote = null;
        }
      } else if (char === quote) {
        if (next === quote) {
          index++;
        } else {
          quote = null;
        }
      } else if (char === "\\") {
        throw new Error(
          "MIGRATION_SQL: Use standard or dollar-quoted strings.",
        );
      }

      continue;
    }

    if (pair === "--") {
      line = true;

      index++;
    } else if (pair === "/*") {
      depth = 1;

      index++;
    } else {
      let valid = char === "'";

      if (!valid) {
        valid = char === '"';
      }

      if (valid) {
        quote = char;
        code += " ? ";
      } else if (char === "$") {
        const match = text
          .slice(index)
          .match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u);

        if (match) {
          quote = match[0];
          index += quote.length - 1;
          code += " ? ";
        } else {
          code += char;
        }
      } else if (char === ";") {
        append(index);
      } else {
        code += char;
      }
    }
  }

  if (quote || depth) {
    throw new Error("MIGRATION_SQL: Unclosed SQL text.");
  }

  append(text.length);

  return statements;
}
