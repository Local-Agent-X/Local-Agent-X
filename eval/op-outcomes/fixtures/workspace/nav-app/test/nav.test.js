import { test } from "node:test";
import assert from "node:assert/strict";
import { createNav } from "../src/nav.js";

test("toggle opens and closes the menu", () => {
  const nav = createNav();
  nav.toggle();
  assert.equal(nav.isOpen(), true);
  nav.toggle();
  assert.equal(nav.isOpen(), false);
});

test("tapping a link closes the menu", () => {
  const nav = createNav();
  nav.toggle();
  assert.deepEqual(nav.navigate("/services"), { href: "/services" });
  assert.equal(nav.isOpen(), false);
});

test("button reads Close while open and Menu while closed", () => {
  const nav = createNav();
  assert.equal(nav.buttonLabel(), "Menu");
  nav.toggle();
  assert.equal(nav.buttonLabel(), "Close");
  nav.toggle();
  assert.equal(nav.buttonLabel(), "Menu");
});
