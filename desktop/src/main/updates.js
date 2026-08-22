"use strict";
/* Update checking against GitHub Releases.
 *
 * Why not electron-updater: applying an update on macOS goes through
 * Squirrel.Mac, which refuses a bundle that is not signed with a Developer ID.
 * Our builds are ad-hoc signed (see scripts/adhoc-sign.js), so it would fail at
 * the last step. We do the same job ourselves instead — verify the download
 * against GitHub's published checksum, check the bundle inside it really is a
 * newer Inkju with an intact signature, then swap it in and relaunch. See
 * installInPlace below. Handing over the disk image is now only the fallback,
 * for when the app cannot write to where it is installed.
 *
 * A Developer ID would still be worth having: it would let this happen on quit
 * with no prompt, and would spare new users the "damaged" warning on first run.
 *
 * This is the ONLY network request Inkju makes, it goes to api.github.com,
 * it sends no identifiers, and it can be turned off in Preferences.
 */
const { net, app, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

const REPO = "royvillasana/inkju";
const API = "https://api.github.com/repos/" + REPO + "/releases/latest";
const RELEASES_PAGE = "https://github.com/" + REPO + "/releases/latest";

/* "2.1.10" is newer than "2.1.9"; a build suffix never makes it newer. */
function compareVersions(a, b){
  const parse = v => String(v || "0").replace(/^v/i, "").split("-")[0].split(".").map(n => parseInt(n, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function request(url, { json = false, timeout = 12000 } = {}){
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: "follow" });
    req.setHeader("User-Agent", "Inkju/" + app.getVersion());
    if (json) req.setHeader("Accept", "application/vnd.github+json");

    const timer = setTimeout(() => { req.abort(); reject(new Error("The update check timed out.")); }, timeout);

    req.on("response", res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer);
        res.resume();
        return reject(new Error("GitHub replied " + res.statusCode));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString("utf8");
        try { resolve(json ? JSON.parse(body) : body); }
        catch (err) { reject(new Error("Could not read GitHub's reply.")); }
      });
    });
    req.on("error", err => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

/* Pick the asset that matches this machine, not just the first one. */
function pickAsset(assets){
  const list = assets || [];
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return list.find(a => a.name.endsWith(".dmg") && a.name.includes(arch))
        || list.find(a => a.name.endsWith(".dmg"))
        || null;
  }
  if (process.platform === "win32") return list.find(a => /\.exe$/i.test(a.name)) || null;
  return list.find(a => /\.(AppImage|deb)$/i.test(a.name)) || null;
}

/* INKJU_FAKE_UPDATE=<version> makes the whole flow exercisable without a
   release to download. Absent in every normal run. */
const FAKE = process.env.INKJU_FAKE_UPDATE || null;

async function check(){
  if (FAKE) {
    return {
      current: app.getVersion(),
      latest: FAKE,
      newer: compareVersions(FAKE, app.getVersion()) > 0,
      name: "Inkju " + FAKE,
      notes: "Pretend release used by the tests.",
      page: RELEASES_PAGE,
      asset: { name: "Inkju-" + FAKE + "-arm64.dmg", url: "fake://asset", size: 4, digest: null }
    };
  }
  const release = await request(API, { json: true });
  const latest = String(release.tag_name || "").replace(/^v/i, "");
  const current = app.getVersion();
  const asset = pickAsset(release.assets);
  return {
    current,
    latest,
    newer: compareVersions(latest, current) > 0,
    name: release.name || ("Inkju " + latest),
    notes: (release.body || "").slice(0, 4000),
    page: release.html_url || RELEASES_PAGE,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null
  };
}

/* Downloads to the user's Downloads folder, reporting progress as it goes. */
function download(asset, onProgress){
  return new Promise((resolve, reject) => {
    if (!asset || !asset.url) return reject(new Error("That release has no download for this platform."));
    if (FAKE) {
      const target = path.join(os.tmpdir(), asset.name);
      if (onProgress) { onProgress(0.5, 2, 4); onProgress(1, 4, 4); }
      return fsp.writeFile(target, "fake")
        .then(() => resolve({ path: target, name: asset.name, size: 4 }))
        .catch(reject);
    }
    const dir = app.getPath("downloads");
    const target = path.join(dir, asset.name);
    const tmp = target + ".part";

    const req = net.request({ url: asset.url, redirect: "follow" });
    req.setHeader("User-Agent", "Inkju/" + app.getVersion());

    req.on("response", res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error("Download failed: GitHub replied " + res.statusCode));
      }
      const total = Number(res.headers["content-length"] || asset.size || 0);
      let got = 0;
      const out = fs.createWriteStream(tmp);
      /* GitHub publishes each asset's sha256, so a download can be checked
         rather than trusted. A file that does not match is deleted, not kept. */
      const hash = crypto.createHash("sha256");

      res.on("data", chunk => {
        got += chunk.length;
        hash.update(chunk);
        out.write(chunk);
        if (onProgress && total) onProgress(Math.min(1, got / total), got, total);
      });
      res.on("end", async () => {
        out.end(async () => {
          try {
            const sum = hash.digest("hex");
            const want = String(asset.digest || "").replace(/^sha256:/i, "").toLowerCase();
            if (want && want !== sum) {
              await fsp.unlink(tmp).catch(() => {});
              return reject(new Error("The download did not match the checksum GitHub published."));
            }
            await fsp.rename(tmp, target);      // only a finished file gets the real name
            resolve({ path: target, name: asset.name, size: got, sha256: sum });
          } catch (err) { reject(err); }
        });
      });
      res.on("error", err => { out.destroy(); fsp.unlink(tmp).catch(() => {}); reject(err); });
    });
    req.on("error", err => { fsp.unlink(tmp).catch(() => {}); reject(err); });
    req.end();
  });
}

/* ---- installing it ourselves ----------------------------------------------
   Squirrel.Mac would do this, but it refuses a bundle that is not signed with a
   Developer ID, and ours is ad-hoc. So we do the same job by hand: verify the
   disk image, stage the new bundle beside the old one, and let a detached
   helper swap them once we have quit.

   Nothing here patches files inside the installed app. A macOS bundle's
   signature seals every file it contains, so editing one in place is exactly
   what produces "Inkju is damaged and can't be opened". The whole bundle is
   replaced, atomically, or nothing happens at all. */

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 1 << 22, ...opts }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).trim())) : resolve(String(stdout)));
});

/* Single-quote a path for /bin/sh. These come from the OS rather than the
   network, but the helper runs unattended and a stray quote would be ugly. */
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

/* Two renames on one volume: each is atomic, and if the second fails the first
   is undone. The worst case is the old app back where it started. */
function swapScript({ appPath, staged, backup, pid, logFile, launcher = "open" }){
  return [
    "#!/bin/sh",
    "# Written by Inkju to finish an update. Safe to delete.",
    "exec >>" + q(logFile) + " 2>&1",
    'echo "--- swap started $(date)"',
    "i=0",
    "while kill -0 " + pid + " 2>/dev/null; do",
    "  i=$((i+1))",
    "  [ $i -gt 600 ] && { echo 'gave up waiting for the app to quit'; exit 1; }",
    "  sleep 0.1",
    "done",
    "[ -d " + q(staged) + " ] || { echo 'staged bundle missing'; exit 1; }",
    "rm -rf " + q(backup),
    "mv " + q(appPath) + " " + q(backup) + " || { echo 'could not move the old app aside'; exit 1; }",
    "if mv " + q(staged) + " " + q(appPath) + "; then",
    "  rm -rf " + q(backup),
    "else",
    "  echo 'swap failed, putting the old app back'",
    "  mv " + q(backup) + " " + q(appPath),
    "  exit 1",
    "fi",
    "echo 'swapped, relaunching'",
    /* the launcher is a seam so the tests can run the real script without
       actually launching an app */
    launcher + " " + q(appPath),
    'rm -f "$0"',
    ""
  ].join("\n");
}

/* The installed bundle, derived from the running binary rather than assumed. */
function bundlePath(){
  const exe = app.getPath("exe");                     // …/Inkju.app/Contents/MacOS/Inkju
  const guess = path.resolve(exe, "..", "..", "..");
  return guess.endsWith(".app") ? guess : null;
}

async function mountedApp(dmg, mountPoint){
  await run("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
  const entries = await fsp.readdir(mountPoint);
  const found = entries.find(e => e.endsWith(".app"));
  if (!found) throw new Error("That disk image has no application in it.");
  return path.join(mountPoint, found);
}

/* Refuse anything not confirmed to be the same app, newer, and intact. */
async function vetBundle(candidate){
  const plist = path.join(candidate, "Contents", "Info.plist");
  const id = (await run("/usr/bin/defaults", ["read", plist, "CFBundleIdentifier"])).trim();
  const version = (await run("/usr/bin/defaults", ["read", plist, "CFBundleShortVersionString"])).trim();

  if (id !== "com.royvillasana.inkju") throw new Error("That disk image contains " + id + ", not Inkju.");
  if (compareVersions(version, app.getVersion()) <= 0) {
    throw new Error("That disk image holds " + version + ", which is not newer than " + app.getVersion() + ".");
  }
  /* the check that would have caught the build that shipped broken */
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate]);
  return version;
}

/* Returns "inplace" when the app will restart itself, and throws when it
   cannot — the caller then falls back to handing the user the disk image. */
async function installInPlace(dmg){
  if (process.platform !== "darwin") throw new Error("In-place install is macOS only.");
  const appPath = bundlePath();
  if (!appPath) throw new Error("Inkju is not running from an app bundle.");

  const parent = path.dirname(appPath);
  /* staging must share the volume with the app, or the rename is not atomic */
  await fsp.access(parent, fs.constants.W_OK)
    .catch(() => { throw new Error("Inkju cannot write to " + parent + ", so it cannot replace itself."); });

  const mountPoint = path.join(os.tmpdir(), "inkju-update-" + process.pid);
  const staged = path.join(parent, ".Inkju-update-" + process.pid + ".app");
  let mounted = false;
  try {
    const candidate = await mountedApp(dmg, mountPoint);
    mounted = true;
    const version = await vetBundle(candidate);

    await fsp.rm(staged, { recursive: true, force: true });
    await run("/usr/bin/ditto", [candidate, staged]);
    /* and again once copied: a truncated copy must not reach the swap */
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);

    await run("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"]).catch(() => {});
    mounted = false;

    const logFile = path.join(app.getPath("userData"), "update.log");
    const script = path.join(os.tmpdir(), "inkju-swap-" + process.pid + ".sh");
    await fsp.writeFile(script, swapScript({
      appPath, staged, backup: staged + ".old", pid: process.pid, logFile
    }), { mode: 0o700 });

    /* detached, so it outlives the quit it is waiting for */
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
    return { mode: "inplace", version };
  } catch (err) {
    if (mounted) await run("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"]).catch(() => {});
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/* Opens the downloaded disk image and shows it in Finder behind. */
async function install(file){
  if (!file) throw new Error("Nothing to install.");
  if (FAKE) return true;
  shell.showItemInFolder(file);
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  return true;
}

module.exports = {
  check, download, install, installInPlace, swapScript, bundlePath,
  compareVersions, pickAsset, RELEASES_PAGE
};
