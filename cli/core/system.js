import * as platform from "#cli/platform/index.js";
import * as linux from "#cli/platform/linux/system.js";
import * as windows from "#cli/platform/windows/startup.js";
import * as mac from "#cli/platform/mac/system.js";
import * as path from "#cli/core/path.js";
import * as config from "#cli/core/config.js";
import { unit } from "#cli/core/unit.js";
import * as primary from "#cli/core/primary.js";

const providers = { linux, win32: linux, darwin: mac };
const provider = providers[process.platform] ?? linux;

export { units, unit } from "#cli/core/unit.js";

export async function state(service, option = {}) {
  unit(service);

  return provider.state(service, option);
}

export function adapter() {
  if (!path.system()) {
    return undefined;
  }

  return provider.adapter();
}

export async function startup(manifest, enabled, option = {}) {
  if (enabled) {
    await primary.guard("DB");
  }

  if (option.services) {
    await provider.startup(manifest, enabled, option);

    return;
  }

  const managed = windows.active(manifest);

  if (!managed) {
    await provider.startup(manifest, enabled);

    return;
  }

  const previous = await config.config();

  await windows.prepare(manifest);

  await windows.set(manifest, false);

  try {
    await provider.startup(manifest, enabled);

    await windows.set(manifest, enabled);
  } catch (failure) {
    await provider.startup(manifest, previous.startup);

    await windows.set(manifest, previous.startup);

    throw failure;
  }
}

export async function validate(services) {
  await provider.validate(services);
}

export async function reload(services = []) {
  await provider.reload(services);
}

export async function fence(record, service, enabled) {
  await provider.fence(record, service, enabled);
}

export async function fenced(record, service) {
  return await provider.fenced(record, service);
}

export async function listener(port) {
  const integer = Number.isInteger(port);
  const positive = port > 0;
  const bounded = port <= 65535;
  const valid = integer && positive && bounded;

  if (!valid) {
    throw new Error("PROMOTION_LISTENER: Unexpected database listener.");
  }

  return await provider.listener(port);
}

export const native = platform.native;
