export function error(code, option = {}) {
  const failure = new Error(
    `CLI_${code.toUpperCase()}: The operation could not complete.`,
  );

  failure.code = code;

  if (option.reason) {
    failure.reason = option.reason;
  }

  if (option.target) {
    failure.target = option.target;
  }

  if (option.guide) {
    failure.guide = option.guide;
  }

  return failure;
}
