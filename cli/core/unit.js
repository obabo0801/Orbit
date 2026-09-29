import { error } from "#cli/core/error.js";

export function units(services) {
  const result = services.filter(function managed(service) {
    return Boolean(service.unit);
  });

  return result;
}

export function unit(service) {
  const expected = {
    DB: "orbit-db.service",
    WAS: "orbit-was.service",
    CADDY: "orbit-caddy.service",
    MONITOR: "orbit-monitor.service",
  };

  if (expected[service.role] !== service.unit) {
    throw error("manifest");
  }

  return service.unit;
}
