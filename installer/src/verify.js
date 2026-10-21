import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isExtensionInstalled } from './extension-embed.js';
import { isInjectPatched } from './patch-inject.js';
import { inspectAlwaysLocalPatch } from './patch-always-local.js';
import { isAgentHostPatched } from './patch-agent-host.js';
import { needsProxy39Patch, isProxy39Patched } from './patch-proxy-39.js';
import { isAgentHostGateFullyPatched } from './patch-agent-host-gate.js';
import { isRuntimeCompatPatched } from './patch-runtime-compat.js';
import { INSTALLATION_MANIFEST, validateInstallation } from './installation-state.js';
import { assertNativeCompatibility, inspectMacOSSignature, macOSBundle, signatureHealthy } from './macos-signing.js';

export function fullyPatched(paths) {
  return isExtensionInstalled(paths)
    && existsSync(paths.workbenchJs) && isInjectPatched(readFileSync(paths.workbenchJs, 'utf8'))
    && (!existsSync(paths.glassJs) || isInjectPatched(readFileSync(paths.glassJs, 'utf8')))
    && inspectAlwaysLocalPatch(paths).fullyPatched && isAgentHostPatched(paths)
    && (!needsProxy39Patch(paths) || isProxy39Patched(paths)) && isAgentHostGateFullyPatched(paths) && isRuntimeCompatPatched(paths);
}

export function verifyPreparedInstallation(paths) {
  if (!existsSync(join(paths.appRoot, INSTALLATION_MANIFEST)) || !fullyPatched(paths))
    throw new Error('Cursor++ patches are missing or incomplete; quit Cursor and run "ccursor update".');
  validateInstallation(paths);
}

export function verifyInstalledApplication(paths) {
  verifyPreparedInstallation(paths);
  const bundle = macOSBundle(paths);
  if (bundle) assertNativeCompatibility(bundle, paths.cursorVersion);
  if (bundle && !signatureHealthy(inspectMacOSSignature(bundle)))
    throw new Error('macOS application signature requires repair; quit Cursor and run "ccursor repair".');
  return true;
}
