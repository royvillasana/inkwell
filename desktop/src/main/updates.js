"use strict";
/* Update checking against GitHub Releases.
 *
 * Why not electron-updater: applying an update in place on macOS goes through
 * Squirrel.Mac, which refuses a bundle that is not signed with a Developer ID.
 * Our builds are ad-hoc signed (see scripts/adhoc-sign.js), so a silent
 * self-install would fail at the last step. Instead we fetch the release, hand
 * the user the DMG we downloaded, and let them drop it in place. The moment a
 * Developer ID exists this can become a real auto-update.
 *
 * This is the ONLY network request Inkwell makes, it goes to api.github.com,
 * it sends no identifiers, and it can be turned off in Preferences.
 */
const { net, app, shell } = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

const REPO = "royvillasana/inkwell";
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
    req.setHeader("User-Agent", "Inkwell/" + app.getVersion());
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

/* INKWELL_FAKE_UPDATE=<version> makes the whole flow exercisable without a
   release to download. Absent in every normal run. */
const FAKE = process.env.INKWELL_FAKE_UPDATE || null;

async function check(){
  if (FAKE) {
    return {
      current: app.getVersion(),
      latest: FAKE,
      newer: compareVersions(FAKE, app.getVersion()) > 0,
      name: "Inkwell " + FAKE,
      notes: "Pretend release used by the tests.",
      page: RELEASES_PAGE,
      asset: { name: "Inkwell-" + FAKE + "-arm64.dmg", url: "fake://asset", size: 4 }
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
    name: release.name || ("Inkwell " + latest),
    notes: (release.body || "").slice(0, 4000),
    page: release.html_url || RELEASES_PAGE,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null
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
    req.setHeader("User-Agent", "Inkwell/" + app.getVersion());

    req.on("response", res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error("Download failed: GitHub replied " + res.statusCode));
      }
      const total = Number(res.headers["content-length"] || asset.size || 0);
      let got = 0;
      const out = fs.createWriteStream(tmp);

      res.on("data", chunk => {
        got += chunk.length;
        out.write(chunk);
        if (onProgress && total) onProgress(Math.min(1, got / total), got, total);
      });
      res.on("end", async () => {
        out.end(async () => {
          try {
            await fsp.rename(tmp, target);      // only a finished file gets the real name
            resolve({ path: target, name: asset.name, size: got });
          } catch (err) { reject(err); }
        });
      });
      res.on("error", err => { out.destroy(); fsp.unlink(tmp).catch(() => {}); reject(err); });
    });
    req.on("error", err => { fsp.unlink(tmp).catch(() => {}); reject(err); });
    req.end();
  });
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

module.exports = { check, download, install, compareVersions, pickAsset, RELEASES_PAGE };
