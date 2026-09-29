import * as fs from "node:fs/promises";
import * as location from "node:path";
import * as command from "#cli/core/process.js";
import { performance } from "node:perf_hooks";

export function check(value, code, message) {
  if (!value) {
    const failure = new Error(`UPDATE_${code}: ${message}`);

    failure.code = `UPDATE_${code}`;

    throw failure;
  }
}

export function sha(value) {
  return /^[a-f0-9]{40}$/u.test(value ?? "");
}

async function execute(checkout, args, option = {}) {
  const settings = {
    cwd: checkout,
    allow: true,
    timeout: 60000,
    env: { GIT_TERMINAL_PROMPT: "0" },
    ...option,
  };

  const user = process.env.SUDO_USER;
  const elevated = process.getuid?.() === 0;
  const native = process.platform !== "win32";
  const owned = Boolean(user);
  const delegated = elevated && native && owned;

  let program = "git";
  let parameters = args;

  if (delegated) {
    program = "/usr/bin/sudo";
    parameters = ["-n", "-H", "-u", user, "--", "git", ...args];
  }

  let result;

  try {
    result = await command.run(program, parameters, settings);
  } catch (cause) {
    const failure = new Error("UPDATE_GIT: Git could not be executed.", {
      cause,
    });

    failure.code = "UPDATE_GIT";

    throw failure;
  }

  return result;
}

async function read(checkout, args) {
  const result = await execute(checkout, args);

  check(result.code === 0, "GIT", "Git inspection failed.");

  return result.output.trim();
}

async function published(checkout, commit) {
  const history = await execute(checkout, [
    "reflog",
    "show",
    "--format=%H",
    "refs/remotes/origin/main",
  ]);

  if (history.code !== 0) {
    return false;
  }

  const entries = history.output.trim().split(/\s+/u).filter(sha);
  const commits = new Set(entries);

  const oldest = await execute(checkout, [
    "rev-parse",
    `refs/remotes/origin/main@{${entries.length}}`,
  ]);

  if (oldest.code === 0) {
    commits.add(oldest.output.trim());
  }

  for (const previous of commits) {
    if (!sha(previous)) {
      continue;
    }

    const result = await execute(checkout, [
      "merge-base",
      "--is-ancestor",
      commit,
      previous,
    ]);

    if (result.code === 0) {
      return true;
    }
  }

  return false;
}

export async function inspect(checkout, option = {}) {
  check(
    location.isAbsolute(checkout),
    "CHECKOUT",
    "Use an absolute Git checkout path.",
  );

  const root = await fs.realpath(checkout);
  const installed = option.installed;

  if (installed) {
    const source = await fs.realpath(installed);
    const relative = location.relative(source, root);
    const nested = relative === "";
    const child = !relative.startsWith("..");
    const absolute = location.isAbsolute(relative);
    const inside = nested || child;
    const contained = !absolute;
    const operating = inside && contained;

    check(
      !operating,
      "CHECKOUT",
      "Installed Source is not a development checkout.",
    );
  }

  const top = await read(root, ["rev-parse", "--show-toplevel"]);

  check(
    (await fs.realpath(top)) === root,
    "CHECKOUT",
    "Use the Git repository root.",
  );

  const branch = await read(root, ["symbolic-ref", "--short", "HEAD"]);
  const commit = await read(root, ["rev-parse", "HEAD"]);
  const origin = await read(root, ["remote", "get-url", "origin"]);

  const pattern =
    /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\.git)?$/iu;

  const https = pattern.test(origin);

  const ssh = /^git@github\.com:[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\.git)?$/iu.test(
    origin,
  );

  const github = https || ssh;

  check(
    github,
    "ORIGIN",
    "Origin must be a GitHub repository without embedded credentials.",
  );

  const repository = origin
    .replace(/^git@github\.com:/iu, "https://github.com/")
    .replace(/\.git$/iu, "")
    .toLowerCase();

  const started = performance.now();
  const fetched = await execute(root, [
    "fetch",
    "--no-tags",
    "origin",
    "refs/heads/main",
  ]);

  if (fetched.code !== 0) {
    const pattern = new RegExp(
      [
        "Authentication failed",
        "Permission denied",
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Repository not found",
        "Could not resolve host",
        "Could not resolve hostname",
        "Failed to connect",
        "Connection refused",
        "Connection timed out",
        "Connection reset",
        "Operation timed out",
        "SSL certificate problem",
        "certificate verification failed",
        "SSL_ERROR_SYSCALL",
        "GnuTLS recv error",
        "RPC failed",
        "Host key verification failed",
        "cannot lock ref",
        "File exists",
        "No space left on device",
        "Read-only file system",
      ].join("|"),
      "giu",
    );

    const matches = fetched.diagnostic.match(pattern) ?? [];
    const diagnostic = [...new Set(matches)].join("; ").slice(0, 512);
    const elapsed = performance.now() - started;
    const terminated = fetched.code === null;
    const expired = elapsed >= 60000;

    let message = diagnostic;

    if (!message) {
      message = "Git fetch failed.";
    }

    const cause = new Error(message);

    const failure = new Error(
      "UPDATE_FETCH: GitHub main could not be fetched.",
      { cause },
    );

    failure.code = "UPDATE_FETCH";
    failure.exit = fetched.code;
    failure.elapsed = elapsed;
    failure.diagnostic = diagnostic;
    failure.timeout = terminated && expired;

    throw failure;
  }

  const latest = await read(root, ["rev-parse", "FETCH_HEAD"]);
  const target = option.target ?? latest;

  check(sha(target), "TARGET", "Invalid target commit.");

  const ancestry = await execute(root, [
    "merge-base",
    "--is-ancestor",
    target,
    latest,
  ]);

  check(
    ancestry.code === 0,
    "TARGET",
    "The fixed target is not part of GitHub main.",
  );

  const status = await read(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const counts = await read(root, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${target}`,
  ]);

  const [ahead, behind] = counts.split(/\s+/u).map(Number);
  const local = ahead > 0;
  const remote = behind > 0;
  const diverged = local && remote;
  const entries = status.split("\n").filter(Boolean);
  const untracked = entries.filter((entry) => entry.startsWith("?? ")).length;
  const changed = entries.length - untracked;

  let reconcile = false;
  let reason = null;

  const main = branch === "main";
  const clean = entries.length === 0;
  const candidate = main && clean && diverged;

  if (candidate) {
    const base = await execute(root, ["merge-base", commit, target]);
    const shallow = await read(root, ["rev-parse", "--is-shallow-repository"]);

    if (shallow === "false") {
      if (base.code === 1) {
        reconcile = await published(root, commit);
      }
    }
  }

  const unresolved = !reconcile;
  const rejected = diverged && unresolved;
  const unpublished = local && unresolved;

  if (branch !== "main") {
    reason = "BRANCH";
  } else if (entries.length) {
    reason = "DIRTY";
  } else if (rejected) {
    reason = "DIVERGED";
  } else if (unpublished) {
    reason = "AHEAD";
  }

  const result = {
    checkout: root,
    branch,
    commit,
    latest,
    target,
    repository,
    changed,
    untracked,
    ahead,
    behind,
    diverged,
    reconcile,
    reason,
    ready: reason === null,
  };

  return result;
}

export function guard(value) {
  const messages = {
    BRANCH: "Switch the development checkout to main first.",
    DIRTY:
      "Commit or remove your pending changes yourself. Update will not stash or delete them.",
    DIVERGED: "Resolve diverged commits yourself before updating.",
    AHEAD:
      "Local commits are ahead of the fixed target. Push or resolve them yourself.",
  };

  check(
    value.ready,
    value.reason ?? "GIT",
    messages[value.reason] ?? "Git checkout is not ready.",
  );
}

async function align(inspection) {
  const checkout = inspection.checkout;
  const prefix = "backup/update-" + inspection.commit.slice(0, 12);
  const commit = await read(checkout, ["rev-parse", "HEAD"]);
  const branch = await read(checkout, ["symbolic-ref", "--short", "HEAD"]);

  const status = await read(checkout, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  check(commit === inspection.commit, "CHANGED", "Checkout commit changed.");

  check(branch === "main", "BRANCH", "Checkout branch changed.");

  check(status === "", "DIRTY", "Checkout changed during preparation.");

  let backup = prefix;
  let suffix = 0;

  for (;;) {
    const existing = await execute(checkout, [
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/" + backup,
    ]);

    if (existing.code === 1) {
      break;
    }

    check(existing.code === 0, "GIT", "Backup branch inspection failed.");

    suffix += 1;
    backup = prefix + "-" + suffix;
  }

  await read(checkout, ["branch", "-m", "main", backup]);

  const preserved = await read(checkout, ["rev-parse", "refs/heads/" + backup]);

  check(
    preserved === commit,
    "CHANGED",
    "Backup commit could not be verified.",
  );

  await read(checkout, ["switch", "--create", "main", inspection.target]);

  await read(checkout, ["branch", "--set-upstream-to=origin/main", "main"]);
}

export async function archive(checkout, target, destination, option = {}) {
  const inspection = await inspect(checkout, { ...option, target });

  guard(inspection);

  if (inspection.reconcile) {
    await align(inspection);
  } else if (inspection.behind) {
    const merged = await execute(inspection.checkout, [
      "merge",
      "--ff-only",
      target,
    ]);

    check(
      merged.code === 0,
      "FORWARD",
      "Fast-forward failed. No forced Git operation was used.",
    );
  }

  const commit = await read(inspection.checkout, ["rev-parse", "HEAD"]);

  const status = await read(inspection.checkout, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  check(
    commit === target,
    "CHANGED",
    "Checkout commit changed during preparation.",
  );

  check(status === "", "DIRTY", "Checkout changed during preparation.");

  const tree = await read(inspection.checkout, ["ls-tree", "-r", target]);

  const links = tree
    .split("\n")
    .some((entry) => /^(?:120000|160000)\s/u.test(entry));

  check(
    !links,
    "SOURCE",
    "Deployment does not accept source symlinks or submodules.",
  );

  const archive = location.join(destination, "source.tar");

  const result = await execute(inspection.checkout, [
    "archive",
    "--format=tar",
    `--output=${archive}`,
    target,
  ]);

  check(
    result.code === 0,
    "ARCHIVE",
    "Target source archive could not be created.",
  );

  return archive;
}
