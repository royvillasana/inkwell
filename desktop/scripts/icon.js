"use strict";
/* Draws the app icon in an offscreen window and turns it into an .icns.
   Run with: npx electron scripts/icon.js                                  */
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OUT = path.join(__dirname, "..", "build");
const SIZE = 1024;

const MARK = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent}
  .sq{
    position:absolute;inset:0;border-radius:225px;
    background:linear-gradient(160deg,#2b2723 0%,#1a1c1f 62%,#141518 100%);
    box-shadow:inset 0 -18px 60px rgba(0,0,0,.45), inset 0 8px 30px rgba(255,255,255,.05);
    overflow:hidden
  }
  .glow{position:absolute;left:-14%;top:-22%;width:80%;height:80%;border-radius:50%;
    background:radial-gradient(circle,rgba(224,160,106,.20),transparent 68%)}
  .drop{position:absolute;left:50%;top:246px;transform:translateX(-50%)}
  .rule{position:absolute;left:300px;right:300px;bottom:214px;height:13px;border-radius:8px;
    background:linear-gradient(90deg,rgba(240,227,216,.9),rgba(240,227,216,.28))}
  .rule.two{bottom:158px;right:404px}
</style>
<div class="sq">
  <div class="glow"></div>
  <svg class="drop" width="372" height="416" viewBox="0 0 42 47" fill="none">
    <defs>
      <linearGradient id="ink" x1="21" y1="1" x2="21" y2="46" gradientUnits="userSpaceOnUse">
        <stop stop-color="#f6e9dd"/><stop offset=".55" stop-color="#e0a06a"/><stop offset="1" stop-color="#b3703c"/>
      </linearGradient>
    </defs>
    <path d="M21 1.5C21 1.5 4.5 21.4 4.5 31.2 4.5 40.2 11.9 46 21 46s16.5-5.8 16.5-14.8C37.5 21.4 21 1.5 21 1.5z"
          fill="url(#ink)"/>
    <path d="M13.4 33.6c0 4.4 3.4 7.7 7.6 7.7" stroke="rgba(255,255,255,.5)" stroke-width="2.4" stroke-linecap="round" fill="none"/>
  </svg>
  <div class="rule"></div>
  <div class="rule two"></div>
</div>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    backgroundColor: "#00000000", webPreferences: { sandbox: true, offscreen: false }
  });
  const tmp = path.join(os.tmpdir(), "inkju-icon-" + Date.now() + ".html");
  fs.writeFileSync(tmp, MARK, "utf8");
  await win.loadFile(tmp);
  await new Promise(r => setTimeout(r, 500));

  const png = (await win.webContents.capturePage()).toPNG();
  fs.mkdirSync(OUT, { recursive: true });
  const master = path.join(OUT, "icon.png");
  fs.writeFileSync(master, png);

  /* macOS iconset -> icns, using the tools that ship with the OS */
  const set = path.join(OUT, "icon.iconset");
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  const specs = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of specs) {
    execFileSync("sips", ["-z", String(s), String(s), master, "--out", path.join(set, "icon_" + s + "x" + s + ".png")], { stdio: "ignore" });
  }
  /* the @2x names Apple expects */
  const pairs = [[16, 32], [32, 64], [128, 256], [256, 512], [512, 1024]];
  for (const [base, big] of pairs) {
    fs.copyFileSync(path.join(set, "icon_" + big + "x" + big + ".png"),
                    path.join(set, "icon_" + base + "x" + base + "@2x.png"));
  }
  for (const s of [64]) fs.rmSync(path.join(set, "icon_" + s + "x" + s + ".png"), { force: true });

  try {
    execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(OUT, "icon.icns")], { stdio: "inherit" });
    console.log("icon: build/icon.icns and build/icon.png written");
  } catch (err) {
    console.log("icon: iconutil failed (" + err.message + "); icon.png is still available");
  }
  fs.rmSync(set, { recursive: true, force: true });
  fs.unlinkSync(tmp);
  app.quit();
});
