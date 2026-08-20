"use strict";
/* Ad-hoc sign the packaged macOS app.
 *
 * Without an Apple Developer ID we cannot produce a signature Gatekeeper will
 * trust, but arm64 macOS still requires the bundle to be *internally
 * consistent*: the Electron binary arrives linker-signed, and once
 * electron-builder renames it and injects app resources that signature no
 * longer seals what is on disk. macOS reports that mismatch to the user as
 * "Inkwell is damaged and can't be opened", and right-click → Open does not
 * help — Gatekeeper never gets that far.
 *
 * Re-signing ad-hoc (`--sign -`) makes the bundle consistent again. The app
 * then behaves like any unsigned download: the "unidentified developer"
 * prompt, which right-click → Open does clear.
 *
 * Signing must run inside-out — every nested binary before the bundle that
 * contains it — or the outer seal covers stale inner signatures.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const NESTED = /\.(framework|app|dylib|so|node)$/;

function collect(dir, found){
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { return found; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      collect(full, found);
      if (NESTED.test(e.name)) found.push(full);
    } else if (NESTED.test(e.name)) {
      found.push(full);
    }
  }
  return found;
}

function sign(target){
  execFileSync("codesign", [
    "--force",
    "--sign", "-",                 // ad-hoc
    "--timestamp=none",
    target
  ], { stdio: "pipe" });
}

exports.default = async function afterPack(context){
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app");
  if (!fs.existsSync(appPath)) {
    console.log("adhoc-sign: no .app at " + appPath + ", skipping");
    return;
  }

  const nested = collect(appPath, []);
  for (const target of nested) {
    try { sign(target); }
    catch (err) { console.warn("adhoc-sign: could not sign " + path.basename(target)); }
  }
  sign(appPath);                    // the bundle itself, last

  /* fail the build rather than ship another "damaged" app */
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  console.log("adhoc-sign: sealed " + (nested.length + 1) + " items, signature verifies");
};
