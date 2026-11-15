#!/usr/bin/env node
// Runs a built page in headless Chromium and reports what it DID, as one JSON
// line on stdout: the visual scenarios' ground truth (scenarios/ice-spill.mjs,
// scenarios/park-walk.mjs). A child process so a scenario's check() stays
// synchronous, as run.mjs and selftest.mjs call it.
//
//   node browser-probe.mjs ice  <index.html>
//   node browser-probe.mjs walk <index.html>
import { pathToFileURL } from "node:url";

const [mode, file] = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); };

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(mode === "ice"
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: false }
    : { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 200)));
  await page.goto(pathToFileURL(file).href);
  await page.waitForTimeout(300);
  out({ errors, ...(mode === "ice" ? await probeIce(page) : await probeWalk(page)), errorsAfter: errors });
} catch (e) {
  out({ fatal: String(e.message ?? e).slice(0, 300) });
} finally {
  await browser.close();
}

/**
 * Ice drawn outside the cup's walls. The canvas is read at three moments
 * (settled, after crunching some pieces, after a shake has settled), then once
 * with the ice removed; a pixel that differs from the empty-cup frame outside
 * the walls is ice (or its outline) drawn past them. A rewrite may redraw the
 * cup and the ice any way it likes; only the page's `cup`, `wallsAt` and
 * `pieces` globals are relied on.
 */
async function probeIce(page) {
  const globalsOk = await page.evaluate(() => typeof cup === "object" && typeof wallsAt === "function" && Array.isArray(pieces));
  if (!globalsOk) return { globalsOk };
  const snap = () => page.evaluate(() => {
    const cv = document.querySelector("canvas");
    return Array.from(cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data);
  });
  const tapCup = async (n) => {
    const box = await page.evaluate(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, top: cup.top, bot: cup.bot, l: wallsAt(cup.bot - 40)[0], r: wallsAt(cup.bot - 40)[1] }; });
    for (let i = 0; i < n; i++) {
      const fx = 0.15 + 0.7 * ((i * 0.618) % 1), fy = 0.45 + 0.4 * ((i * 0.381) % 1);
      await page.mouse.click(box.x + box.l + (box.r - box.l) * fx, box.y + box.top + (box.bot - box.top) * fy);
      await page.waitForTimeout(120);
    }
  };
  await page.waitForTimeout(4500);
  const frames = [await snap()];
  const before = await page.evaluate(() => pieces.length);
  await tapCup(10);
  await page.waitForTimeout(2500);
  frames.push(await snap());
  const afterTaps = await page.evaluate(() => pieces.length);
  const shake = await page.$("#shake");
  if (shake) { await shake.click(); await page.waitForTimeout(4000); frames.push(await snap()); }
  const moving = await page.evaluate(() => new Promise((res) => {
    const cv = document.querySelector("canvas"), g = cv.getContext("2d");
    const a = g.getImageData(0, 0, cv.width, cv.height).data;
    pieces.forEach((p) => { p.vy = (p.vy || 0) - 6; });
    setTimeout(() => { const b = g.getImageData(0, 0, cv.width, cv.height).data; let d = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 3] !== b[i + 3] || a[i] !== b[i]) d++; res(d); }, 300);
  }));
  const geom = await page.evaluate(async () => {
    pieces.length = 0;
    if (typeof shards !== "undefined" && Array.isArray(shards)) shards.length = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Drawing units to canvas pixels: the context's own scale (devicePixelRatio
    // there), not the on-screen size, which CSS may stretch.
    const cv = document.querySelector("canvas");
    const k = cv.getContext("2d").getTransform().a || 1, rows = [];
    for (let y = Math.ceil(cup.top + 10); y < cup.bot - 4; y++) { const [l, r] = wallsAt(y); rows.push([y, l, r]); }
    return { k, width: cv.width, height: cv.height, rows };
  });
  const empty = await snap();
  const MARGIN = 2.5; // the wall stroke's half-width plus antialiasing, in CSS px
  const spill = frames.map((f) => {
    let px = 0, worst = 0;
    for (const [y, l, r] of geom.rows) {
      const py = Math.round(y * geom.k);
      for (let px_ = 0; px_ < geom.width; px_++) {
        const cssX = px_ / geom.k;
        const outside = cssX < l - MARGIN ? l - cssX : cssX > r + MARGIN ? cssX - r : 0;
        if (!outside) continue;
        const i = (py * geom.width + px_) * 4;
        if (Math.abs(f[i + 3] - empty[i + 3]) > 24 || Math.abs(f[i] - empty[i]) > 24 || Math.abs(f[i + 2] - empty[i + 2]) > 24) { px++; worst = Math.max(worst, outside); }
      }
    }
    return { px, worst: Math.round(worst * 10) / 10 };
  });
  return { globalsOk, before, afterTaps, moving, spill };
}

/**
 * Camera-relative movement: at several camera angles, hold each key and see
 * which way the player went relative to where the camera looks. Then a jump.
 */
async function probeWalk(page) {
  const globalsOk = await page.evaluate(() => !!(window.game && game.player && typeof game.camYaw === "number"));
  if (!globalsOk) return { globalsOk };
  await page.click("canvas").catch(() => {});
  const hold = async (yaw, code, ms) => {
    await page.evaluate((yaw) => { game.camYaw = yaw; game.player.x = 0; game.player.z = 0; game.player.y = 0; }, yaw);
    await page.waitForTimeout(150);
    const a = await page.evaluate(() => ({ x: game.player.x, z: game.player.z, yaw: game.camYaw }));
    await page.keyboard.down(code); await page.waitForTimeout(ms); await page.keyboard.up(code);
    await page.waitForTimeout(80);
    const b = await page.evaluate(() => ({ x: game.player.x, z: game.player.z, yaw: game.camYaw }));
    // Where the camera looked when the key went down: from the camera to the player.
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw), rx = -fz, rz = fx;
    const dx = b.x - a.x, dz = b.z - a.z;
    return { yaw, code, forward: +(dx * fx + dz * fz).toFixed(2), right: +(dx * rx + dz * rz).toFixed(2), yawChange: +(b.yaw - a.yaw).toFixed(2) };
  };
  const moves = [];
  for (const yaw of [0, Math.PI / 2, Math.PI, 2.356]) {
    for (const code of ["KeyW", "KeyS", "KeyA", "KeyD"]) moves.push(await hold(yaw, code, 700));
  }
  const idle = await page.evaluate(() => new Promise((res) => {
    game.player.x = 0; game.player.z = 0; game.player.y = 0;
    setTimeout(() => res(Math.hypot(game.player.x, game.player.z)), 500);
  }));
  await page.evaluate(() => { game.player.y = 0; });
  await page.keyboard.down("Space"); await page.waitForTimeout(60); await page.keyboard.up("Space");
  const ys = [];
  for (let i = 0; i < 40; i++) { ys.push(await page.evaluate(() => game.player.y)); await page.waitForTimeout(50); }
  return { globalsOk, moves, idle, jumpMax: Math.max(...ys), jumpMin: Math.min(...ys), jumpEnd: ys[ys.length - 1] };
}
