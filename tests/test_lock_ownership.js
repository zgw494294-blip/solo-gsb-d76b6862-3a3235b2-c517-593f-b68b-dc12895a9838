"use strict";

// 前端「条款锁定（定稿保护）」的回归测试。
//
// 覆盖：
// 1. 锁定集合仅存本页内存：成功导入、重新导入、成功恢复存档均清空；锁定切换不发请求、
//    不改正文 / 顺序 / 身份上界 / 复核记录。
// 2. 含失效引用的条款不能锁定。
// 3. 写稿请求（合并 / 拆分 / 复制 / 删除）与保存请求随附最新锁定集合；
//    后端按实际结果核验，409（锁定冲突）时草稿、身份上界与复核均不变；
//    复制允许、副本不锁定。
// 4. 成功回包按**最新**锁定集合复核：写稿等待期间切换锁定，违例整次不安装
//    （不先更新身份上界与复核）。
// 5. 旧响应不得写回新稿（沿用既有请求归属）。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// fetch 由测试逐个收尾。
// 运行：node --test tests/test_lock_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// fetch 桩：记录每一次请求，响应时机与结果完全由测试控制
// --------------------------------------------------------------------------- //
function makeFetchStub() {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = {
        url,
        method: opts.method || "GET",
        body: opts.body ? JSON.parse(opts.body) : null,
        settled: false,
        respond(status, data) {
          call.settled = true;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => data,
          });
        },
        fail(err) {
          call.settled = true;
          reject(err || new TypeError("fetch failed"));
        },
      };
      calls.push(call);
    });
  fetch.calls = calls;
  fetch.last = (url) => [...calls].reverse().find((c) => c.url === url);
  fetch.wait = async (url) => {
    for (let i = 0; i < 50; i++) {
      const c = fetch.last(url);
      if (c) return c;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`request to ${url} not observed`);
  };
  return fetch;
}

function makeElement(name) {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    name,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    dataset: {},
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((fn) => fn(event)));
    },
    querySelector(sel) {
      if (el._bySel && el._bySel.has(sel)) return el._bySel.get(sel);
      return null;
    },
    // 测试用：挂一个可被 querySelector 找到的子元素
    _attach(sel, child) {
      if (!el._bySel) el._bySel = new Map();
      el._bySel.set(sel, child);
      return child;
    },
    querySelectorAll: () => [],
    appendChild: () => {},
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    closest: () => null,
    click: () => {},
  };
  return el;
}

function loadApp() {
  const elements = new Map();
  const cards = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel));
    return elements.get(sel);
  };
  const fetch = makeFetchStub();
  const alerts = [];
  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: (sel) => (sel === ".card" ? [...cards.values()] : []),
      getElementById: (id) => {
        if (id.startsWith("card-")) {
          const cid = id.slice(5);
          if (!cards.has(cid)) cards.set(cid, makeElement(id));
          return cards.get(cid);
        }
        return null;
      },
      createElement: () => makeElement("el"),
      createDocumentFragment: () => makeElement("fragment"),
    },
    fetch,
    confirm: () => true,
    alert: (...args) => alerts.push(args.join(" ")),
    console,
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook =
    "\n;globalThis.__app = {" +
    " state, touch, installArchive, submitWrite, lockFindings, toggleLock," +
    " syncLockCard, saveEdit, lockedIdsSnapshot" +
    " };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return {
    fetch,
    alerts,
    cards,
    __doc: sandbox.document,
    state: sandbox.__app.state,
    touch: sandbox.__app.touch,
    installArchive: sandbox.__app.installArchive,
    submitWrite: sandbox.__app.submitWrite,
    lockFindings: sandbox.__app.lockFindings,
    toggleLock: sandbox.__app.toggleLock,
    syncLockCard: sandbox.__app.syncLockCard,
    saveEdit: sandbox.__app.saveEdit,
    lockedIdsSnapshot: sandbox.__app.lockedIdsSnapshot,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// vm 内数组原型与测试侧不同，deepStrictEqual 会误判；经 JSON 往返后再比较
const rt = (v) => JSON.parse(JSON.stringify(v));

// 直接布置一份已保存草稿（绕过导入流程，聚焦锁定逻辑）
function setupDraft(app, clauses) {
  app.state.clauses = (clauses || [
    { id: "c1", original: 1, body: "甲方在七日内交付设备" },
    { id: "c2", original: 2, body: "乙方按 [[c1]] 验收后付款" },
    { id: "c3", original: 3, body: "争议解决见 [[c2]]" },
    { id: "c4", original: 4, body: "争议提交仲裁" },
  ]).map((c) => ({ ...c }));
  app.state.orderIds = app.state.clauses.map((c) => c.id);
  app.state.idCounter = app.state.clauses.length;
  app.state.previewFresh = true;
  app.state.preview = {
    has_broken: false,
    items: app.state.clauses.map((c, i) => ({
      id: c.id,
      display: i + 1,
      original: c.original,
      text: c.body,
      broken: [],
    })),
  };
}

// --------------------------------------------------------------------------- //
// lockFindings：与后端同口径的实际结果复核
// --------------------------------------------------------------------------- //
test("lockFindings 按实际结果识别 removed / body_changed / ref_broken 并按旧顺序排列", () => {
  const app = loadApp();
  setupDraft(app);
  const oldOrder = ["c1", "c2", "c3", "c4"];
  const oldBodies = Object.fromEntries(app.state.clauses.map((c) => [c.id, c.body]));

  // 删除 c1：锁定 c1（removed）、c2（引用失效）、c4（无关，不报）
  const newOrder = ["c2", "c3", "c4"];
  const newBodies = Object.fromEntries(
    app.state.clauses.filter((c) => c.id !== "c1").map((c) => [c.id, c.body]),
  );
  const f = app.lockFindings(oldOrder, oldBodies, newOrder, newBodies, ["c4", "c2", "c1"]);
  assert.deepEqual(
    rt(f.map((x) => [x.id, x.reason])),
    [
      ["c1", "removed"],
      ["c2", "ref_broken"],
    ],
  );
  assert.equal(f[1].ref_id, "c1");
  assert.equal(f[1].ref_original, 1);

  // 正文逐字变化
  const bodies2 = { ...oldBodies, c2: "乙方按 [[c1]] 验收后三十日付款" };
  const f2 = app.lockFindings(oldOrder, oldBodies, oldOrder, bodies2, ["c2", "c3"]);
  assert.deepEqual(
    rt(f2.map((x) => [x.id, x.reason])),
    [["c2", "body_changed"]],
  );

  // 纯重排：不报
  const f3 = app.lockFindings(
    oldOrder,
    oldBodies,
    ["c4", "c3", "c2", "c1"],
    oldBodies,
    ["c1", "c2"],
  );
  assert.equal(f3.length, 0);

  // 被引用条款正文改变不影响锁定它的引用者：c2 引用 c1，改 c1 正文不报
  const bodies4 = { ...oldBodies, c1: "甲方三十日内交付" };
  const f4 = app.lockFindings(oldOrder, oldBodies, oldOrder, bodies4, ["c2"]);
  assert.equal(f4.length, 0);

  // 空集合：永远无违例
  assert.equal(app.lockFindings(oldOrder, oldBodies, newOrder, newBodies, []).length, 0);
});

// --------------------------------------------------------------------------- //
// 锁定生命周期：仅存本页内存
// --------------------------------------------------------------------------- //
test("锁定集合随重新导入与成功恢复存档清空，存档快照不含锁定", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.lockedIds = ["c1", "c2"];

  // 真实「重新导入」处理器：世代推进并清空草稿与锁定（确认弹窗桩恒为真）
  const reimport = app.__doc.querySelector("#reimport-btn");
  await reimport.fire("click");
  await flush();
  assert.deepEqual(rt(app.state.lockedIds), []);
  assert.deepEqual(rt(app.state.orderIds), []);

  // 恢复存档安装：installArchive 内部清空
  setupDraft(app);
  app.state.lockedIds = ["c1"];
  const snap = {
    baseline: {
      order_ids: ["c1", "c2"],
      clauses: [
        { id: "c1", body: "存档第一条" },
        { id: "c2", body: "存档第二条见 [[c1]]" },
      ],
    },
    order_ids: ["c1", "c2"],
    clauses: [
      { id: "c1", body: "存档第一条" },
      { id: "c2", body: "存档第二条见 [[c1]]" },
    ],
    id_counter: 2,
  };
  app.installArchive(snap, 2);
  assert.deepEqual(rt(app.state.lockedIds), []);
});

// app.js 启动时以 $("#...") 缓存了工具栏元素；loadApp 中 querySelector 对同一选择器
// 返回同一元素，这里经 document.querySelector 取回被缓存的那个实例以触发其监听器
function requireVMElement(app, sel) {
  return app.__doc.querySelector(sel);
}

// --------------------------------------------------------------------------- //
// 含失效引用的条款不能锁定；锁定切换不改正文 / 复核
// --------------------------------------------------------------------------- //
test("含失效引用的条款不能锁定；锁定不触碰草稿、上界与复核", () => {
  const app = loadApp();
  setupDraft(app);
  // c2 预览项有失效引用
  app.state.preview.items[1].broken = [{ ref_id: "c9", original: 9 }];
  app.toggleLock("c2");
  assert.deepEqual(rt(app.state.lockedIds), []);
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /失效引用/);

  // 无失效引用：可锁定，仅改内存
  app.state.preview.items[1].broken = [];
  const before = JSON.stringify(app.state.clauses);
  const revBefore = app.state.rev;
  app.state.reviews = [{ id: "c2", bodies: { c2: "乙方按 [[c1]] 验收后付款", c1: "甲方在七日内交付设备" } }];
  app.toggleLock("c1");
  assert.deepEqual(rt(app.state.lockedIds), ["c1"]);
  assert.equal(JSON.stringify(app.state.clauses), before);
  assert.equal(app.state.rev, revBefore, "锁定不 touch、不推进修订号");
  assert.equal(app.state.idCounter, 4);
  assert.equal(app.state.reviews.length, 1, "锁定切换不改复核");

  // 再次切换：解锁
  app.toggleLock("c1");
  assert.deepEqual(rt(app.state.lockedIds), []);
  assert.equal(app.state.reviews.length, 1, "解锁也不改复核");
});

test("预览未同步时不能新锁定，但可以解锁", () => {
  const app = loadApp();
  setupDraft(app);
  app.state.previewFresh = false;
  app.toggleLock("c1");
  assert.deepEqual(rt(app.state.lockedIds), []);

  // 已锁定时预览失效：解锁仍允许
  app.state.lockedIds = ["c1"];
  app.toggleLock("c1");
  assert.deepEqual(rt(app.state.lockedIds), []);
});

// --------------------------------------------------------------------------- //
// 写稿请求随附锁定集合；409 整次拒绝，草稿 / 上界 / 复核不变
// --------------------------------------------------------------------------- //
test("写稿请求携带 locked_ids；后端 409 锁定冲突时草稿、身份上界与复核均不变", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.lockedIds = ["c2"];
  app.state.reviews = [{ id: "c2", bodies: { c2: "乙方按 [[c1]] 验收后付款", c1: "甲方在七日内交付设备" } }];

  const done = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c1" },
    onError: () => {},
  });
  const call = await app.fetch.wait("/api/delete");
  assert.deepEqual(rt(call.body.locked_ids), ["c2"]);
  call.respond(409, {
    detail: {
      errors: ["操作与已定稿（锁定）条款冲突，整次拒绝：", "锁定条款 c2 的有效引用 c1 将失去目标"],
      locked_errors: [
        { id: "c2", original: 2, reason: "ref_broken", ref_id: "c1", ref_original: 1 },
      ],
    },
  });
  await done;
  await flush();

  assert.deepEqual(rt(app.state.orderIds), ["c1", "c2", "c3", "c4"], "拒绝后草稿不变");
  assert.equal(app.state.idCounter, 4);
  assert.equal(app.state.reviews.length, 1, "拒绝不影响复核");
  assert.equal(app.state.writing, null);
});

test("复制请求携带锁定集合且成功安装；副本不锁定、上界采用接口返回", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.lockedIds = ["c2"];
  const done = app.submitWrite({
    kind: "duplicate",
    path: "/api/duplicate",
    params: { selected_ids: ["c2"], next_id: 4 },
    onError: (errors) => assert.fail("不应失败：" + errors.join(";")),
  });
  const call = await app.fetch.wait("/api/duplicate");
  assert.deepEqual(rt(call.body.locked_ids), ["c2"]);
  call.respond(200, {
    order_ids: ["c1", "c2", "c5", "c3", "c4"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c5", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c3", body: "争议解决见 [[c2]]" },
      { id: "c4", body: "争议提交仲裁" },
    ],
    next_id: 5,
  });
  await done;
  await flush();
  assert.deepEqual(rt(app.state.orderIds), ["c1", "c2", "c5", "c3", "c4"]);
  assert.equal(app.state.idCounter, 5);
  assert.deepEqual(rt(app.state.lockedIds), ["c2"], "副本不锁定，原锁定保留");
});

// --------------------------------------------------------------------------- //
// 成功回包按最新锁定集合复核：等待期间切换锁定，违例整次不安装
// --------------------------------------------------------------------------- //
test("写稿等待期间新增锁定：成功回包违例则整次不安装（不动上界与复核）", async () => {
  const app = loadApp();
  setupDraft(app);
  // 提交时没有锁定；删除 c1
  const done = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c1" },
    onError: () => {},
  });
  const call = await app.fetch.wait("/api/delete");
  assert.deepEqual(rt(call.body.locked_ids), []);

  // 等待期间锁定 c2（它引用 c1）——锁定切换在等待时允许
  app.state.lockedIds = ["c2"];
  app.state.reviews = [{ id: "c2", bodies: { c2: "乙方按 [[c1]] 验收后付款", c1: "甲方在七日内交付设备" } }];

  // 后端按空集合判定成功；前端按最新集合复核，违例整次不安装
  call.respond(200, {
    order_ids: ["c2", "c3", "c4"],
    clauses: [
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c3", body: "争议解决见 [[c2]]" },
      { id: "c4", body: "争议提交仲裁" },
    ],
  });
  await done;
  await flush();

  assert.deepEqual(rt(app.state.orderIds), ["c1", "c2", "c3", "c4"], "违例结果不得安装");
  assert.equal(app.state.clauses.length, 4);
  assert.equal(app.state.idCounter, 4, "不得先更新身份上界");
  assert.equal(app.state.reviews.length, 1, "不得改动复核");
  assert.equal(app.state.writing, null);

  // 等待期间解锁则成功结果可安装
  const done2 = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c1" },
    onError: () => {},
  });
  const call2 = await app.fetch.wait("/api/delete");
  app.state.lockedIds = []; // 等待期间解锁
  call2.respond(200, {
    order_ids: ["c2", "c3", "c4"],
    clauses: [
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c3", body: "争议解决见 [[c2]]" },
      { id: "c4", body: "争议提交仲裁" },
    ],
  });
  await done2;
  await flush();
  assert.deepEqual(rt(app.state.orderIds), ["c2", "c3", "c4"]);
});

// --------------------------------------------------------------------------- //
// 保存请求同样随附锁定集合；409 时草稿不变
// --------------------------------------------------------------------------- //
test("保存请求携带 locked_ids；后端 409 锁定冲突时草稿不变", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.lockedIds = ["c2"];

  // 在 c2 卡片上挂编辑器 textarea 与错误列表
  const card = app.__doc.getElementById("card-c2");
  card._attach("textarea", { value: "被锁定的新正文" });
  const errBox = makeElement("edit-errors");
  errBox.hidden = true;
  errBox.innerHTML = "";
  card._attach('[data-role="edit-errors"]', errBox);

  const done = app.saveEdit("c2");
  const call = await app.fetch.wait("/api/save");
  assert.deepEqual(rt(call.body.locked_ids), ["c2"]);
  call.respond(409, {
    detail: {
      errors: ["操作与已定稿（锁定）条款冲突：", "锁定条款 c2 的内部正文将被改动"],
      locked_errors: [{ id: "c2", original: 2, reason: "body_changed" }],
    },
  });
  await done;
  await flush();

  assert.equal(app.state.clauses.find((c) => c.id === "c2").body, "乙方按 [[c1]] 验收后付款");
  assert.equal(errBox.hidden, false, "错误显示在编辑器卡片上");
  assert.match(errBox.innerHTML, /锁定/);
});

test("保存等待期间新增锁定：成功回包违例则不写回", async () => {
  const app = loadApp();
  setupDraft(app);
  const card = app.__doc.getElementById("card-c1");
  card._attach("textarea", { value: "甲方改为三十日交付" });
  const errBox = makeElement("edit-errors");
  errBox.hidden = true;
  card._attach('[data-role="edit-errors"]', errBox);

  // 提交时 c1 未锁
  const done = app.saveEdit("c1");
  const call = await app.fetch.wait("/api/save");
  assert.deepEqual(rt(call.body.locked_ids), []);
  // 等待期间锁定 c1
  app.state.lockedIds = ["c1"];
  call.respond(200, { id: "c1", body: "甲方改为三十日交付" });
  await done;
  await flush();
  assert.equal(
    app.state.clauses.find((c) => c.id === "c1").body,
    "甲方在七日内交付设备",
    "违例回包不得写回",
  );
  assert.equal(errBox.hidden, false);
});

// --------------------------------------------------------------------------- //
// 旧响应不得写回新稿（锁定随写稿也沿用请求归属）
// --------------------------------------------------------------------------- //
test("换稿后迟到的写稿成功响应不写回、不解除等待", async () => {
  const app = loadApp();
  setupDraft(app);
  app.state.lockedIds = ["c1"];
  const done = app.submitWrite({
    kind: "delete",
    path: "/api/delete",
    params: { delete_id: "c4" },
    onError: () => {},
  });
  const call = await app.fetch.wait("/api/delete");
  // 等待期间换稿（模拟重新导入：世代推进 + 序号作废）
  app.state.epoch += 1;
  call.respond(200, { order_ids: ["c1", "c2", "c3"], clauses: app.state.clauses.filter((c) => c.id !== "c4") });
  await done;
  await flush();
  assert.deepEqual(rt(app.state.orderIds), ["c1", "c2", "c3", "c4"], "旧响应不得写回新稿");
});
