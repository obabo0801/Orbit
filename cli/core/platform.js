import * as linux from "#cli/platform/linux/host.js";
import * as mac from "#cli/platform/mac/host.js";

const providers = { linux, win32: linux, darwin: mac };
const selected = providers[process.platform];

export const host = selected;

export { linux, windows, mac, native } from "#cli/platform/index.js";
