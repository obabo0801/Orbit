import * as linux from "#cli/platform/linux/resource.js";
import * as mac from "#cli/platform/mac/resource.js";

const providers = { linux, win32: linux, darwin: mac };
const provider = providers[process.platform] ?? linux;

export { thresholds, scopes, tone } from "#cli/core/measurement.js";

export function session() {
  return provider.session();
}
