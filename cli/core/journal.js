import * as linux from "#cli/platform/linux/journal.js";
import * as mac from "#cli/platform/mac/journal.js";

const providers = { linux, win32: linux, darwin: mac };
const provider = providers[process.platform] ?? linux;

export async function entries(service, option = {}) {
  return provider.entries(service, option);
}
