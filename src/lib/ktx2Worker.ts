// Runs KTX2Loader's worker script (a blob: URL, sent as the first message) inside this same-origin worker. A blob:
// worker would inherit the window's CSP, which forbids eval, and the Basis transcoder's Emscripten glue builds
// functions with `new Function`. This file is served without that policy.
declare function importScripts(...urls: string[]): void;

self.onmessage = (e: MessageEvent<string>) => {
  self.onmessage = null;
  importScripts(e.data);
};
