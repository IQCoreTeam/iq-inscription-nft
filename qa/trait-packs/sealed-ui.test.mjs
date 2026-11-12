import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
if (!process.env.IQ_UI_TEST_DEPS)
  throw Error("Set IQ_UI_TEST_DEPS to the existing UI test package");
const { JSDOM } = createRequire(process.env.IQ_UI_TEST_DEPS + "/package.json")(
  "jsdom",
);
const html = await readFile(
  new URL("./sealed-preview.html", import.meta.url),
  "utf8",
);
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
}
function setup(t) {
  const dom = new JSDOM(
      html.replace(/<script type="module">[\s\S]*?<\/script>/, ""),
      { runScripts: "outside-only", url: "http://127.0.0.1:4590/" },
    ),
    w = dom.window;
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const actions = [];
  const data = {
    release: { unminted: 7, minted: 1, opened: 0, sealed: 1 },
    actors: { a: "alice", b: "bob" },
    packs: [{ serial: 0, asset: "known-asset", owner: "alice", opened: false }],
    listings: [],
  };
  w.fetch = async (url, options) => {
    if (url === "/action") {
      const body = JSON.parse(options.body);
      actions.push(body);
      if (body.action === "list") {
        data.listings = [{ asset: "known-asset", seller: "alice", price: 0.2 }];
        data.packs[0].owner = "escrow";
      } else if (body.action === "purchase") {
        data.listings = [];
        data.packs[0].owner = "bob";
      }
    }
    return { ok: true, json: async () => data };
  };
  w.eval(source);
  return { w, actions };
}
test("sealed page confirms actions once, keeps actor stable and renders distinct ownership/listings", async (t) => {
  const { w, actions } = setup(t);
  await settle();
  const click = (text) =>
    [...w.document.querySelectorAll("button")]
      .find((b) => b.textContent === text)
      .click();
  assert.match(w.document.querySelector("#owned").textContent, /Pack #1/);
  click("List pack");
  assert.equal(w.document.querySelector("#confirm").open, true);
  click("Collector B");
  click("Cancel");
  await settle();
  assert.equal(actions.length, 0);
  click("List pack");
  click("Confirm local transaction");
  click("Confirm local transaction");
  await settle();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actor, "a");
  assert.equal(actions[0].price, 0.2);
  click("Collector B");
  assert.match(w.document.querySelector("#owned").textContent, /No sealed/);
  click("Buy listed pack");
  click("Confirm local transaction");
  await settle();
  assert.equal(actions[1].expectedLamports, 200000000);
  assert.match(w.document.querySelector("#owned").textContent, /Pack #1/);
});
test("preview remains explicitly local and does not embed private wallet material", () => {
  assert.match(html, /LOCAL SURFPOOL/);
  assert.match(html, /simulated\s+oracle/);
  assert.doesNotMatch(html, /secretKey|seedPhrase|privateKey|mnemonic/);
});
