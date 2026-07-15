/**
 * Bridge Glue
 *
 * Tauri-side wiring for the companion-extension bridge: owns the pairing
 * token, subscribes to `bridge:request` events from the Rust loopback server
 * (src-tauri/src/commands/bridge.rs), routes them through the pure router
 * (bridgeRoutes.js) with the app's real modules injected, and answers via the
 * `bridge_respond` command. No-op outside Tauri (browser dev/tests).
 */

import { appStorage } from './appStorage.js';
import { createBridgeRouter } from './bridgeRoutes.js';
import { getVariants, getUserProfile } from './persistence.js';
import { addApplication } from './applications.js';
import { getAllLearnedAnswers, saveLearnedAnswer } from './learnedAnswers.js';
import { completeForBridge } from './aiService.js';

const TOKEN_KEY = 'resume-designer-bridge-token';

// Same Tauri sniff as appStorage.js (duplicated for the same cycle reason).
const IS_TAURI =
  typeof window !== 'undefined' &&
  ('isTauri' in window || '__TAURI_INTERNALS__' in window || '__TAURI__' in window);

export function getBridgeToken() {
  return appStorage.getItem(TOKEN_KEY) || '';
}

function ensureBridgeToken() {
  let token = getBridgeToken();
  if (!token) {
    token = crypto.randomUUID();
    appStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

export async function initBridge() {
  if (!IS_TAURI) return;
  ensureBridgeToken();

  const [{ listen }, { invoke }, { getVersion }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/app'),
  ]);
  const version = await getVersion();

  // Defensive lookup of pdf.js's export: if the module fails to load or the
  // export is missing, the PDF route 500s cleanly instead of breaking init.
  let exportVariantPdf = async () => {
    throw new Error('PDF export over the bridge is not available yet');
  };
  try {
    const pdf = await import('./pdf.js');
    if (typeof pdf.exportVariantPdfBase64 === 'function') {
      exportVariantPdf = pdf.exportVariantPdfBase64;
    }
  } catch (e) {
    console.warn('[Bridge] pdf module unavailable:', e);
  }

  const handle = createBridgeRouter({
    version,
    getToken: getBridgeToken,
    getVariants,
    getUserProfile,
    getLearnedAnswers: getAllLearnedAnswers,
    addApplication,
    saveLearnedAnswer,
    complete: completeForBridge,
    exportVariantPdf,
  });

  await listen('bridge:request', async (event) => {
    const { id, method, path, authorization, body } = event.payload || {};
    let res;
    try {
      res = await handle({ method, path, authorization, body });
    } catch (err) {
      res = { status: 500, body: { error: err?.message || 'internal error' } };
    }
    try {
      await invoke('bridge_respond', { id, status: res.status, body: JSON.stringify(res.body) });
    } catch (err) {
      // Late answer after the HTTP thread timed out — nothing to do.
      console.warn('[Bridge] respond failed:', err);
    }
  });
  console.log('[Bridge] ready on 127.0.0.1:17872');
}
