import { loadAsset } from '../config/load.js';

/** config_hash of a confirmed row when the asset YAML is gone or no longer loads: the confirm still goes through. */
export const UNLOADED_CONFIG_HASH = 'unloaded';

/**
 * The asset config hash for a confirm (`data confirm`, a `confirm_observation` approval): the loaded YAML's hash, or
 * UNLOADED_CONFIG_HASH when it is missing or invalid. A confirm decides on a stored row, so it never needs the YAML.
 */
export function confirmConfigHash(home: string, assetId: string): string {
  try {
    return loadAsset(home, assetId).hash;
  } catch {
    return UNLOADED_CONFIG_HASH;
  }
}
