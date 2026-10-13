// theory_lib.js - the theory file format, for the page when it reads and writes
// the library through GitHub instead of the local server.
//
// theory_lib.py is the reference and the only one the local server uses. This
// port exists because the phone has no Python; both are held to
// tests/format_cases.json (test_lib.py and test_format.js), so a format change
// made on one side fails the tests until the other follows.
//
// Only operations that write a single file live here: a GitHub contents write
// is one file per commit, so anything touching several files (rename, abstract,
// delete, import) stays with the local server, where it is one atomic change.
(function (root) {
"use strict";

const BAD_ID_CHARS = new Set('\\/:*?"<>|[],#\n\r\t');
const RESERVED = new Set(["con", "prn", "aux", "nul"]);
for (let i = 1; i < 10; i++) { RESERVED.add("com" + i); RESERVED.add("lpt" + i); }
const LEGACY_HEADING = /^##\s+(繼承自\s+\S.*|自有)\s*$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DIGITS = /^[0-9]+$/;

class OpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function idProblem(nid) {
  if (!nid || nid !== nid.trim()) return "id 不能是空的，頭尾也不能有空白";
  if ("._".includes(nid[0])) return "id 不能以 . 或 _ 開頭";
  const bad = [...new Set([...nid].filter((c) => BAD_ID_CHARS.has(c)))].sort();
  if (bad.length) return "id 不能包含：" + bad.map((c) => ("\n\r\t".includes(c) ? "空白字元" : c)).join(" ");
  if (RESERVED.has(nid.toLowerCase())) return "id 不能是系統保留的檔名";
  if ([...nid].length > 80) return "id 太長（最多 80 字）";
  return null;
}

function makeNode(id, f) {
  return Object.assign({ id, parents: [], order: null, created: null, disabled: false,
    body: "", raw: "", hash: "", parsed: true, errors: [], warnings: [] }, f);
}

function fail(id, raw, hash, msg) { return makeNode(id, { raw, hash, parsed: false, errors: [msg] }); }

function trimBlankLines(lines) {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join("\n");
}

function parse(id, raw, hash = "") {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return fail(id, raw, hash, "檔案要以 --- 開頭的 frontmatter 開始");
  let end = text.indexOf("\n---\n", 3);
  if (end < 0) {
    if (text.endsWith("\n---")) end = text.length - 4;
    else return fail(id, raw, hash, "frontmatter 沒有結尾的 ---");
  }
  const fm = text.slice(4, end), body = text.slice(end + 5);
  const f = { parents: [], order: null, created: null, disabled: false };
  const seen = new Set();
  for (const line of fm.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    const key = (at < 0 ? line : line.slice(0, at)).trim(), val = at < 0 ? "" : line.slice(at + 1).trim();
    if (at >= 0 && key === "summary") {
      if (!val) continue;
      return fail(id, raw, hash, "summary 已經不用了，標題就說明何時該選這個理論："
        + "把 summary 的內容併進內文或刪掉，再存檔");
    }
    if (at < 0 || !["parents", "order", "created", "disabled"].includes(key)) {
      return fail(id, raw, hash, "frontmatter 只能有 parents、order、created、disabled："
        + "看不懂這一行「" + line + "」");
    }
    if (seen.has(key)) return fail(id, raw, hash, "frontmatter 的 " + key + " 出現了兩次");
    seen.add(key);
    if (key === "disabled") {
      if (val !== "true" && val !== "false") return fail(id, raw, hash, "disabled 只能是 true 或 false");
      f.disabled = val === "true";
    } else if (key === "order") {
      if (!DIGITS.test(val)) return fail(id, raw, hash, "order 要是 0 以上的整數");
      f.order = parseInt(val, 10);
    } else if (key === "created") {
      if (!DATE.test(val)) return fail(id, raw, hash, "created 要寫成 2026-10-13 這種日期");
      f.created = val;
    } else {
      if (!(val.startsWith("[") && val.endsWith("]"))) return fail(id, raw, hash, "parents 要寫成 [a, b] 的形式");
      f.parents = val.slice(1, -1).split(",").map((p) => p.trim()).filter(Boolean);
      if (new Set(f.parents).size !== f.parents.length) return fail(id, raw, hash, "parents 裡有重複的 id");
    }
  }
  let lines = body.split("\n"), i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && lines[i].startsWith("# ")) i++;
  lines = lines.slice(i).map((x) => (LEGACY_HEADING.test(x) ? "#" + x : x));
  return makeNode(id, Object.assign(f, { body: trimBlankLines(lines), raw, hash }));
}

function serialize(n) {
  const out = ["---", "parents: [" + n.parents.join(", ") + "]"];
  if (n.order !== null) out.push("order: " + n.order);
  if (n.created !== null) out.push("created: " + n.created);
  if (n.disabled) out.push("disabled: true");
  out.push("---", "# " + n.id, "");
  const body = trimBlankLines(n.body.replace(/\r\n/g, "\n").split("\n"));
  if (body) out.push(body, "");
  return out.join("\n");
}

// --- graph --------------------------------------------------------------------

function parentsIn(nodes, id) {
  const n = nodes[id];
  return n ? n.parents.filter((p) => p in nodes) : [];
}

function ancestors(nodes, id) {
  const seen = new Set(), stack = parentsIn(nodes, id);
  while (stack.length) {
    const p = stack.pop();
    if (!seen.has(p)) { seen.add(p); stack.push(...parentsIn(nodes, p)); }
  }
  return seen;
}

function descendantsMap(nodes) {
  const kids = {};
  for (const id of Object.keys(nodes)) kids[id] = [];
  for (const id of Object.keys(nodes).sort()) for (const p of parentsIn(nodes, id)) kids[p].push(id);
  const out = {};
  for (const id of Object.keys(nodes)) {
    const seen = new Set(), stack = [...kids[id]];
    while (stack.length) {
      const c = stack.pop();
      if (!seen.has(c)) { seen.add(c); stack.push(...kids[c]); }
    }
    out[id] = [...seen].sort();
  }
  return out;
}

function annotate(nodes) {
  for (const [id, n] of Object.entries(nodes)) {
    if (!n.parsed) continue;
    n.errors = []; n.warnings = [];
    for (const p of n.parents) {
      if (p === id) n.errors.push("parents 裡有自己");
      else if (!(p in nodes)) n.errors.push("父節點 " + p + " 不存在");
    }
    if (ancestors(nodes, id).has(id)) n.errors.push("在循環裡：沿著 parents 往上走會回到自己");
    if (!n.body.trim()) n.warnings.push("內文是空的");
  }
}

function byOrder(nodes) {
  return (a, b) => {
    const x = nodes[a].order, y = nodes[b].order;
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    if (x !== y) return (x || 0) - (y || 0);
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

// the same rows as theory_lib.tree_rows over the real edges
function treeRows(nodes) {
  const parents = {};
  for (const id of Object.keys(nodes)) parents[id] = parentsIn(nodes, id);
  const ranked = Object.keys(parents).sort(byOrder(nodes));
  const kids = {};
  for (const id of ranked) kids[id] = [];
  for (const id of ranked) for (const p of parents[id]) if (p in kids) kids[p].push(id);
  const rows = [], shown = new Set();
  const walk = (id, depth, path) => {
    shown.add(id);
    const also = parents[id].filter((p) => !path.length || p !== path[path.length - 1]);
    rows.push({ id, depth, also, key: [...path, id].join("/") });
    for (const c of kids[id] || []) if (!path.includes(c) && c !== id) walk(c, depth + 1, [...path, id]);
  };
  for (const id of ranked) if (!parents[id].length) walk(id, 0, []);
  const stranded = ranked.filter((id) => !shown.has(id));
  if (stranded.length) {
    rows.push({ marker: "cycle", depth: 0, key: "#cycle" });
    for (const id of stranded) if (!shown.has(id)) walk(id, 1, ["#cycle"]);
  }
  return rows;
}

// files: {id: {raw, hash}} -> nodes annotated as the server would
function load(files) {
  const nodes = {};
  for (const [id, f] of Object.entries(files)) {
    nodes[id] = f.raw === null ? fail(id, "", f.hash, "讀不到檔案內容（不是文字檔，或太大）") : parse(id, f.raw, f.hash);
  }
  annotate(nodes);
  return nodes;
}

// --- single-file operations: each returns the one file to write ------------------

function today() {
  const d = new Date(), pad = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function existing(nodes, id) {
  const n = nodes[id];
  if (!n) throw new OpError(404, "找不到 " + id);
  return n;
}

function parsedCopy(n) {
  if (!n.parsed) throw new OpError(400, n.id + " 的格式有誤，請先在原始文字裡修好");
  return Object.assign({}, n, { parents: [...n.parents] });
}

function checkEdge(nodes, child, parent) {
  if (!(parent in nodes)) throw new OpError(400, "父節點 " + parent + " 不存在");
  if (child === parent || ancestors(nodes, parent).has(child)) {
    throw new OpError(400, "把 " + child + " 掛到 " + parent + " 下會形成循環");
  }
}

function nextOrder(nodes) {
  return Math.max(0, ...Object.values(nodes).map((n) => n.order).filter((o) => o !== null)) + 1;
}

function create(nodes, id, parents) {
  const problem = idProblem(id);
  if (problem) throw new OpError(400, problem);
  if (Object.keys(nodes).some((k) => k.toLowerCase() === id.toLowerCase())) {
    throw new OpError(409, "已經有叫 " + id + " 的理論了");
  }
  if (new Set(parents).size !== parents.length) throw new OpError(400, "parents 裡有重複的 id");
  for (const p of parents) checkEdge(nodes, id, p);
  const n = makeNode(id, { parents: [...parents], order: nextOrder(nodes), created: today() });
  return { id, text: serialize(n), create: true };
}

function save(nodes, id, body) {
  const n = parsedCopy(existing(nodes, id));
  n.body = body;
  return { id, text: serialize(n) };
}

function saveRaw(nodes, id, text) {
  existing(nodes, id);
  return { id, text };
}

function addParent(nodes, id, parent) {
  const n = parsedCopy(existing(nodes, id));
  if (n.parents.includes(parent)) throw new OpError(400, parent + " 已經是 " + id + " 的父節點");
  checkEdge(nodes, id, parent);
  n.parents.push(parent);
  return { id, text: serialize(n) };
}

function removeParent(nodes, id, parent) {
  const n = parsedCopy(existing(nodes, id));
  if (!n.parents.includes(parent)) throw new OpError(400, parent + " 不是 " + id + " 的父節點");
  n.parents = n.parents.filter((p) => p !== parent);
  return { id, text: serialize(n) };
}

function moveParent(nodes, id, from, to) {
  const n = parsedCopy(existing(nodes, id));
  if (!n.parents.includes(from)) throw new OpError(400, from + " 不是 " + id + " 的父節點");
  if (n.parents.includes(to)) throw new OpError(400, to + " 已經是 " + id + " 的父節點");
  checkEdge(nodes, id, to);
  n.parents[n.parents.indexOf(from)] = to;
  return { id, text: serialize(n) };
}

function setDisabled(nodes, id, disabled) {
  const n = parsedCopy(existing(nodes, id));
  n.disabled = !!disabled;
  return { id, text: serialize(n) };
}

const api = { OpError, idProblem, parse, serialize, load, treeRows, descendantsMap,
  create, save, saveRaw, addParent, removeParent, moveParent, setDisabled };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.TheoryLib = api;
})(this);
