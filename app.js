"use strict";

const editor = document.getElementById("editor");
const highlightCode = document.getElementById("highlight-code");
const highlightBox = document.getElementById("highlight");
const gutter = document.getElementById("gutter");
const consoleBox = document.getElementById("console");
const statusEl = document.getElementById("status");
const splitEl = document.getElementById("split");
const dividerEl = document.getElementById("divider");

const STORAGE_KEY = "writejs.code";

// carry over state saved under the old jsrun.* keys
for (const [oldKey, newKey] of [
  ["jsrun.code", "writejs.code"],
  ["jsrun.theme", "writejs.theme"],
  ["jsrun.formatOnSave", "writejs.formatOnSave"],
]) {
  const v = localStorage.getItem(oldKey);
  if (v !== null && localStorage.getItem(newKey) === null) {
    localStorage.setItem(newKey, v === "jsrun" ? "writejs" : v);
  }
  localStorage.removeItem(oldKey);
}

const DEFAULT_CODE = `// writejs.io — write JS on the left, see results on the right
// ⌘S formats, ⌘↩ (or Run) executes

const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));

console.log("fib(1..10):", Array.from({ length: 10 }, (_, i) => fib(i + 1)));

const user = { name: "Vlad", tags: ["js", "hacking"], active: true };
console.log(user);

console.warn("warnings look like this");

// last expression value is echoed back, REPL-style
fib(20);
`;

/* ---------------- syntax highlight ---------------- */

const KEYWORDS = new Set(
  ("const let var function return if else for while do switch case break " +
   "continue new delete typeof instanceof in of class extends super this " +
   "import export from default try catch finally throw async await yield " +
   "void static get set").split(" ")
);
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const TOKEN_RE = new RegExp(
  [
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)",                       // 1 comment
    "(`|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*')",     // 2 string / template start
    "(\\b0[xXbBoO][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)",      // 3 number
    "([A-Za-z_$][\\w$]*)",                                          // 4 word
  ].join("|"),
  "g"
);

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// index just past the closing backtick of a template starting at `start`
function scanTemplate(src, start) {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") { i = scanTemplate(src, i); continue; }
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return src.length;
}

function stringSpan(s) {
  return `<span class="tok-string">${escapeHtml(s)}</span>`;
}

// template literal → string chunks + recursively highlighted ${expressions}
function highlightTemplate(tpl) {
  let out = "";
  let i = 0;
  let chunkStart = 0;
  while (i < tpl.length) {
    if (tpl[i] === "\\") { i += 2; continue; }
    if (tpl[i] === "$" && tpl[i + 1] === "{") {
      out += stringSpan(tpl.slice(chunkStart, i));
      let depth = 1;
      let j = i + 2;
      while (j < tpl.length && depth > 0) {
        if (tpl[j] === "\\") { j += 2; continue; }
        if (tpl[j] === "`") { j = scanTemplate(tpl, j); continue; }
        if (tpl[j] === "{") depth++;
        else if (tpl[j] === "}") depth--;
        j++;
      }
      const closed = depth === 0;
      out += '<span class="tok-interp">${</span>' +
        highlight(tpl.slice(i + 2, closed ? j - 1 : j)) +
        (closed ? '<span class="tok-interp">}</span>' : "");
      chunkStart = j;
      i = j;
      continue;
    }
    i++;
  }
  out += stringSpan(tpl.slice(chunkStart));
  return out;
}

function highlight(src) {
  let out = "";
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    const [text] = m;
    if (text === "`") {
      const end = scanTemplate(src, m.index);
      out += highlightTemplate(src.slice(m.index, end));
      TOKEN_RE.lastIndex = end;
      last = end;
      continue;
    }
    let cls = null;
    if (m[1]) cls = "tok-comment";
    else if (m[2]) cls = "tok-string";
    else if (m[3]) cls = "tok-number";
    else if (m[4]) {
      if (KEYWORDS.has(text)) cls = "tok-keyword";
      else if (LITERALS.has(text)) cls = "tok-literal";
    }
    out += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    last = m.index + text.length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

function refresh() {
  // trailing newline so the overlay's last line scrolls in sync with the textarea
  highlightCode.innerHTML = highlight(editor.value) + "\n";
  const lines = editor.value.split("\n").length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  syncScroll();
}

function syncScroll() {
  highlightBox.scrollTop = editor.scrollTop;
  highlightBox.scrollLeft = editor.scrollLeft;
  marksEl.scrollTop = editor.scrollTop;
  marksEl.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

editor.addEventListener("scroll", () => {
  syncScroll();
  if (ac) acPosition();
});

let saveTimer;
editor.addEventListener("input", (e) => {
  if (multi && !multiEditing) exitMulti();
  refresh();
  acOnInput(e);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(STORAGE_KEY, editor.value), 300);
});

/* ---------------- editing niceties ---------------- */

function insertText(text) {
  if (!document.execCommand("insertText", false, text)) {
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
  }
}

function toggleComment() {
  const value = editor.value;
  let { selectionStart: selStart, selectionEnd: selEnd } = editor;
  const hadSelection = selEnd > selStart;

  // full-line selections often end right after a newline — don't touch that next line
  let effEnd = selEnd;
  if (hadSelection && value[selEnd - 1] === "\n") effEnd = selEnd - 1;

  const blockStart = value.lastIndexOf("\n", selStart - 1) + 1;
  let blockEnd = value.indexOf("\n", effEnd);
  if (blockEnd === -1) blockEnd = value.length;

  const lines = value.slice(blockStart, blockEnd).split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) {
    insertText("// ");
    return;
  }
  const allCommented =
    nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*\/\//.test(l));

  let firstDelta = 0;
  let totalDelta = 0;
  let newLines;
  if (allCommented) {
    newLines = lines.map((l, i) => {
      const stripped = l.replace(/^(\s*)\/\/ ?/, "$1");
      const d = stripped.length - l.length;
      if (i === 0) firstDelta = d;
      totalDelta += d;
      return stripped;
    });
  } else {
    const indent = Math.min(
      ...nonEmpty.map((l) => l.match(/^[ \t]*/)[0].length)
    );
    newLines = lines.map((l, i) => {
      if (l.trim() === "") return l;
      const commented = l.slice(0, indent) + "// " + l.slice(indent);
      if (i === 0) firstDelta = 3;
      totalDelta += 3;
      return commented;
    });
  }

  editor.setSelectionRange(blockStart, blockEnd);
  insertText(newLines.join("\n"));

  const clamp = (n) => Math.max(blockStart, n);
  if (hadSelection) {
    editor.setSelectionRange(clamp(selStart + firstDelta), selEnd + totalDelta);
  } else {
    const caret = clamp(selStart + firstDelta);
    editor.setSelectionRange(caret, caret);
  }
}

editor.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (ac && !mod && !e.altKey) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      acMove(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      acAccept();
      return;
    }
    if (e.key === "Escape") {
      acClose();
      return;
    }
  }
  if (mod && e.key === "/") {
    e.preventDefault();
    toggleComment();
  } else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    cmdD();
  } else if (e.key === "Escape") {
    exitMulti();
  } else if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    if (multi) doMultiEdit("insert", "  ");
    else insertText("  ");
  } else if (e.key === "Enter" && !multi) {
    const before = editor.value.slice(0, editor.selectionStart);
    const indent = (before.slice(before.lastIndexOf("\n") + 1).match(/^[ \t]*/) || [""])[0];
    if (indent) {
      e.preventDefault();
      insertText("\n" + indent);
    }
  } else if (QUOTES.has(e.key) && !multi && !mod && !e.altKey) {
    const { selectionStart: s, selectionEnd: en } = editor;
    const v = editor.value;
    if (s === en && v[s] === e.key) {
      // closing quote already there — type over it
      e.preventDefault();
      editor.setSelectionRange(s + 1, s + 1);
    } else if (s !== en) {
      // wrap the selection
      e.preventDefault();
      const inner = v.slice(s, en);
      insertText(e.key + inner + e.key);
      editor.setSelectionRange(s + 1, s + 1 + inner.length);
    } else if (!(e.key === "'" && /[\w$]/.test(v[s - 1] || ""))) {
      // insert a pair, caret in the middle — but plain apostrophes (don't) stay single
      e.preventDefault();
      insertText(e.key + e.key);
      editor.setSelectionRange(s + 1, s + 1);
    }
  } else if (e.key === "Backspace" && !multi && !mod) {
    const { selectionStart: s, selectionEnd: en } = editor;
    const v = editor.value;
    if (s === en && s > 0 && QUOTES.has(v[s - 1]) && v[s] === v[s - 1]) {
      // backspace inside an empty pair removes both quotes
      e.preventDefault();
      editor.setSelectionRange(s - 1, s + 1);
      if (!document.execCommand("delete")) {
        editor.setRangeText("", s - 1, s + 1, "end");
        editor.dispatchEvent(new Event("input"));
      }
    }
  } else if (multi && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || (mod && e.key.toLowerCase() === "z"))) {
    exitMulti();
  }
});

const QUOTES = new Set(['"', "'", "`"]);

/* ---------------- multi-select (⌘D, VS Code style) ---------------- */

const marksEl = document.getElementById("marks");
let multi = null; // { ranges: [{start,end}], primary: index }
let multiEditing = false;

function wordRangeAt(pos) {
  const v = editor.value;
  let s = pos;
  let e = pos;
  while (s > 0 && /[\w$]/.test(v[s - 1])) s--;
  while (e < v.length && /[\w$]/.test(v[e])) e++;
  return e > s ? { start: s, end: e } : null;
}

function findOccurrences(text, needle, wholeWord) {
  const ranges = [];
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    const before = text[i - 1] || "";
    const after = text[i + needle.length] || "";
    if (!wholeWord || (!/[\w$]/.test(before) && !/[\w$]/.test(after))) {
      ranges.push({ start: i, end: i + needle.length });
    }
    i += needle.length;
  }
  return ranges;
}

function renderMarks() {
  if (!multi) {
    marksEl.innerHTML = "";
    return;
  }
  const v = editor.value;
  let html = "";
  let last = 0;
  for (const r of multi.ranges) {
    html += escapeHtml(v.slice(last, r.start));
    html += r.start === r.end
      ? '<span class="mark caret"></span>'
      : `<span class="mark">${escapeHtml(v.slice(r.start, r.end))}</span>`;
    last = r.end;
  }
  html += escapeHtml(v.slice(last)) + "\n";
  marksEl.innerHTML = html;
  syncScroll();
}

function exitMulti() {
  if (!multi) return;
  multi = null;
  marksEl.innerHTML = "";
}

function cmdD() {
  const { selectionStart: s, selectionEnd: e } = editor;
  if (s === e) {
    const r = wordRangeAt(s);
    if (r) editor.setSelectionRange(r.start, r.end);
    return;
  }
  const needle = editor.value.slice(s, e);
  if (!needle.trim() || needle.includes("\n")) return;
  const wholeWord = /^[\w$]+$/.test(needle);
  const ranges = findOccurrences(editor.value, needle, wholeWord);
  if (ranges.length < 2) {
    flashStatus("only match");
    return;
  }
  multi = { ranges, primary: ranges.findIndex((r) => r.start === s) };
  if (multi.primary === -1) multi.primary = 0;
  renderMarks();
  flashStatus(`${ranges.length} selected — type to edit all, Esc to exit`);
}

function applyMultiEdit(value, ranges, type, data) {
  let out = "";
  let last = 0;
  let shift = 0;
  const newRanges = [];
  for (const r of ranges) {
    let s = Math.max(r.start, last);
    let end = Math.max(r.end, s);
    let insert = "";
    if (type === "insert") insert = data;
    else if (type === "deleteBackward" && s === end) s = Math.max(last, s - 1);
    else if (type === "deleteForward" && s === end) end = Math.min(value.length, end + 1);
    out += value.slice(last, s) + insert;
    const caret = s + shift + insert.length;
    newRanges.push({ start: caret, end: caret });
    shift += insert.length - (end - s);
    last = end;
  }
  out += value.slice(last);
  return { value: out, ranges: newRanges };
}

function doMultiEdit(type, data) {
  const res = applyMultiEdit(editor.value, multi.ranges, type, data);
  multiEditing = true;
  editor.setSelectionRange(0, editor.value.length);
  document.execCommand("insertText", false, res.value);
  if (editor.value !== res.value) {
    editor.value = res.value;
    editor.dispatchEvent(new Event("input"));
  }
  multiEditing = false;
  multi.ranges = res.ranges;
  const p = res.ranges[Math.min(multi.primary, res.ranges.length - 1)];
  editor.setSelectionRange(p.start, p.end);
  renderMarks();
}

editor.addEventListener("beforeinput", (e) => {
  if (!multi || multiEditing) return;
  let type = null;
  let data = "";
  if (e.inputType === "insertText" || e.inputType === "insertFromPaste") {
    type = "insert";
    data = e.data ?? (e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
  } else if (e.inputType === "insertLineBreak") {
    type = "insert";
    data = "\n";
  } else if (e.inputType === "deleteContentBackward") {
    type = "deleteBackward";
  } else if (e.inputType === "deleteContentForward") {
    type = "deleteForward";
  } else {
    exitMulti();
    return;
  }
  e.preventDefault();
  doMultiEdit(type, data);
});

editor.addEventListener("mousedown", () => {
  exitMulti();
  acClose();
});

/* ---------------- autocomplete ---------------- */

const acEl = document.getElementById("ac");

const AC_GLOBALS = (
  "console Math JSON Object Array String Number Boolean Promise Date RegExp " +
  "Map Set WeakMap WeakSet Symbol BigInt Error TypeError RangeError parseInt " +
  "parseFloat isNaN isFinite fetch setTimeout setInterval clearTimeout " +
  "clearInterval structuredClone queueMicrotask requestAnimationFrame " +
  "document window navigator localStorage sessionStorage alert"
).split(" ");

const AC_MEMBERS = [...new Set((
  "log warn error info table debug map filter reduce forEach find findIndex " +
  "some every includes indexOf lastIndexOf slice splice push pop shift unshift " +
  "join concat flat flatMap fill sort reverse keys values entries length " +
  "toString toFixed toPrecision split replace replaceAll trim trimStart trimEnd " +
  "toUpperCase toLowerCase startsWith endsWith padStart padEnd repeat charAt " +
  "charCodeAt at then catch finally stringify parse assign freeze fromEntries " +
  "floor ceil round abs min max random sqrt pow sign trunc now getTime " +
  "toISOString add has get set delete clear size name apply call bind " +
  "test exec match matchAll search"
).split(" "))];

let ac = null; // { items, index, start, token }
let acAccepting = false;
let acMetrics = null;

function acTokenAt(pos) {
  const before = editor.value.slice(0, pos);
  const token = (before.match(/([A-Za-z_$][\w$]*)?$/)[1] || "");
  const start = pos - token.length;
  return { token, start, member: editor.value[start - 1] === "." };
}

function acCandidates(token, start, member) {
  const value = editor.value;
  // words already in the document, minus the one being typed
  const doc = value.slice(0, start) + " " + value.slice(start + token.length);
  const freq = new Map();
  for (const w of doc.match(/[A-Za-z_$][\w$]+/g) || []) {
    if (!KEYWORDS.has(w) && !LITERALS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const pool = [];
  const seen = new Set();
  const push = (w) => {
    if (!seen.has(w)) {
      seen.add(w);
      pool.push(w);
    }
  };
  const docWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);
  if (member) {
    // after a dot, known methods first — doc words are mostly noise there
    AC_MEMBERS.forEach(push);
    docWords.forEach(push);
  } else {
    docWords.forEach(push);
    [...KEYWORDS, ...LITERALS, ...AC_GLOBALS].forEach(push);
  }

  const lower = token.toLowerCase();
  const exact = [];
  const loose = [];
  for (const w of pool) {
    if (w === token) continue;
    if (w.startsWith(token)) exact.push(w);
    else if (token && w.toLowerCase().startsWith(lower)) loose.push(w);
  }
  return [...exact, ...loose].slice(0, 8);
}

function acUpdate() {
  if (multi) return acClose();
  const pos = editor.selectionStart;
  if (pos !== editor.selectionEnd) return acClose();
  const { token, start, member } = acTokenAt(pos);
  if (!member && !token) return acClose();
  const items = acCandidates(token, start, member);
  if (!items.length) return acClose();
  ac = { items, index: 0, start, token };
  acRender();
}

function acRender() {
  ac.items.forEach((w, i) => {
    if (!acEl.children[i]) acEl.appendChild(document.createElement("div"));
  });
  while (acEl.children.length > ac.items.length) acEl.lastChild.remove();
  ac.items.forEach((w, i) => {
    const el = acEl.children[i];
    el.className = "ac-item" + (i === ac.index ? " active" : "");
    el.dataset.i = i;
    el.innerHTML =
      `<b>${escapeHtml(w.slice(0, ac.token.length))}</b>` +
      escapeHtml(w.slice(ac.token.length));
  });
  acEl.hidden = false;
  acPosition();
  const active = acEl.children[ac.index];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function acPosition() {
  if (!acMetrics) {
    const cs = getComputedStyle(editor);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    acMetrics = {
      charW: ctx.measureText("M").width,
      lineH: parseFloat(cs.lineHeight),
      padL: parseFloat(cs.paddingLeft),
      padT: parseFloat(cs.paddingTop),
    };
  }
  const before = editor.value.slice(0, ac.start);
  const line = (before.match(/\n/g) || []).length;
  const col = ac.start - (before.lastIndexOf("\n") + 1);
  const stack = editor.parentElement;
  const { charW, lineH, padL, padT } = acMetrics;

  let x = padL + col * charW - editor.scrollLeft;
  let y = padT + (line + 1) * lineH - editor.scrollTop + 2;
  x = Math.max(0, Math.min(x, stack.clientWidth - acEl.offsetWidth - 4));
  const above = padT + line * lineH - editor.scrollTop - acEl.offsetHeight - 2;
  if (y + acEl.offsetHeight > stack.clientHeight && above > 0) y = above;
  acEl.style.left = x + "px";
  acEl.style.top = y + "px";
}

function acClose() {
  if (ac) {
    ac = null;
    acEl.hidden = true;
  }
}

function acMove(dir) {
  ac.index = (ac.index + dir + ac.items.length) % ac.items.length;
  acRender();
}

function acAccept(i = ac.index) {
  const { start, token } = ac;
  const word = ac.items[i];
  acClose();
  if (word === token) return;
  acAccepting = true;
  editor.setSelectionRange(start, start + token.length);
  insertText(word);
  acAccepting = false;
}

function acOnInput(e) {
  if (acAccepting || multi) return acClose();
  if (e.inputType === "insertText" && e.data && /^[\w$.]$/.test(e.data)) {
    acUpdate();
  } else if (ac && e.inputType === "deleteContentBackward") {
    acUpdate();
  } else {
    acClose();
  }
}

acEl.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the editor focused
  const item = e.target.closest(".ac-item");
  if (item) acAccept(+item.dataset.i);
});

editor.addEventListener("blur", acClose);

/* ---------------- console rendering ---------------- */

function span(cls, text) {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function fmtValue(v, depth = 0, seen = new WeakSet()) {
  const t = typeof v;
  if (v === null) return span("v-literal", "null");
  if (t === "undefined") return span("v-literal", "undefined");
  if (t === "boolean") return span("v-literal", String(v));
  if (t === "number" || t === "bigint") return span("v-number", String(v));
  if (t === "string")
    return depth === 0 ? escapeHtml(v) : span("v-string", JSON.stringify(v));
  if (t === "function") {
    const name = v.name ? ` ${v.name}` : "";
    return span("v-fn", `ƒ${name}()`);
  }
  if (t === "symbol") return span("v-literal", v.toString());

  if (v instanceof Error) return escapeHtml(v.stack || `${v.name}: ${v.message}`);
  if (seen.has(v)) return span("v-literal", "[Circular]");
  if (depth > 3) return escapeHtml(Array.isArray(v) ? "[…]" : "{…}");
  seen.add(v);

  if (Array.isArray(v)) {
    const items = v.slice(0, 100).map((x) => fmtValue(x, depth + 1, seen));
    if (v.length > 100) items.push(`… ${v.length - 100} more`);
    return `[${items.join(", ")}]`;
  }
  if (v instanceof Map) {
    const items = [...v].slice(0, 50).map(
      ([k, val]) => `${fmtValue(k, depth + 1, seen)} => ${fmtValue(val, depth + 1, seen)}`
    );
    return `Map(${v.size}) {${items.join(", ")}}`;
  }
  if (v instanceof Set) {
    const items = [...v].slice(0, 50).map((x) => fmtValue(x, depth + 1, seen));
    return `Set(${v.size}) {${items.join(", ")}}`;
  }
  if (v instanceof Date) return span("v-string", v.toISOString());
  if (typeof Node !== "undefined" && v instanceof Node)
    return escapeHtml(`<${(v.nodeName || "node").toLowerCase()}>`);

  const proto = Object.getPrototypeOf(v);
  const ctor = proto && proto.constructor && proto.constructor.name;
  const label = ctor && ctor !== "Object" ? ctor + " " : "";
  const entries = Object.entries(v).slice(0, 50).map(
    ([k, val]) => `${span("v-key", k)}: ${fmtValue(val, depth + 1, seen)}`
  );
  return `${escapeHtml(label)}{ ${entries.join(", ")} }`;
}

const TAGS = { log: "›", info: "i", warn: "▲", error: "✕", result: "◂" };

function addEntry(kind, args, { raw = false } = {}) {
  const empty = consoleBox.querySelector(".console-empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = `entry ${kind}`;
  const body = raw
    ? escapeHtml(args.join(" "))
    : args.map((a) => fmtValue(a)).join(" ");
  el.innerHTML = `<span class="tag">${TAGS[kind] || "›"}</span><span class="msg">${
    kind === "result" ? `<span class="val">${body}</span>` : body
  }</span>`;
  consoleBox.appendChild(el);
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function clearConsole() {
  consoleBox.innerHTML = '<div class="console-empty">Console is empty — run some code.</div>';
}

/* ---------------- running ---------------- */

let sandbox = null;

function makeSandbox() {
  if (sandbox) sandbox.remove();
  sandbox = document.createElement("iframe");
  sandbox.style.display = "none";
  document.body.appendChild(sandbox);
  const w = sandbox.contentWindow;

  const hook = (method, kind) => {
    const orig = w.console[method].bind(w.console);
    w.console[method] = (...args) => {
      addEntry(kind, args);
      orig(...args);
    };
  };
  hook("log", "log");
  hook("info", "info");
  hook("debug", "log");
  hook("warn", "warn");
  hook("error", "error");

  w.addEventListener("error", (e) => {
    addEntry("error", [e.error || e.message], { raw: !e.error });
  });
  w.addEventListener("unhandledrejection", (e) => {
    addEntry("error", [e.reason]);
  });
  return w;
}

function runCode() {
  const code = editor.value;
  const w = makeSandbox();
  try {
    const result = w.eval(code);
    if (result !== undefined) addEntry("result", [result]);
    if (result instanceof w.Promise || result instanceof Promise) {
      result.then(
        (v) => v !== undefined && addEntry("result", [v]),
        () => {} // surfaced via unhandledrejection hook
      );
    }
  } catch (err) {
    // top-level await needs an async wrapper
    if (err instanceof w.SyntaxError && /await/.test(code)) {
      w.eval(`(async () => {\n${code}\n})()`).catch((e) => addEntry("error", [e]));
    } else {
      addEntry("error", [err]);
    }
  }
}

/* ---------------- formatting ---------------- */

let statusTimer;
function flashStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
  statusEl.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove("show"), 1600);
}

async function formatCode() {
  exitMulti();
  try {
    const { formatted, cursorOffset } = await prettier.formatWithCursor(editor.value, {
      cursorOffset: editor.selectionStart,
      parser: "babel",
      plugins: [prettierPlugins.babel, prettierPlugins.estree],
    });
    if (formatted !== editor.value) {
      const { scrollTop } = editor;
      editor.value = formatted;
      editor.setSelectionRange(cursorOffset, cursorOffset);
      editor.scrollTop = scrollTop;
      refresh();
      localStorage.setItem(STORAGE_KEY, formatted);
    }
    flashStatus("Formatted");
  } catch (err) {
    const firstLine = String(err.message || err).split("\n")[0];
    flashStatus("Syntax error", true);
    addEntry("error", [`Format failed — ${firstLine}`], { raw: true });
  }
}

/* ---------------- color themes ---------------- */

const THEMES = {
  "writejs": { label: "writejs (default)", scheme: "dark", vars: {
    "--ground": "#12151c", "--panel": "#181d27", "--panel-edge": "#232a38",
    "--ink": "#d7dce6", "--muted": "#69738a", "--accent": "#e8a15c", "--accent-ink": "#1a1208",
    "--syn-keyword": "#8fb8f2", "--syn-string": "#9ece8c", "--syn-number": "#d6a26e",
    "--syn-comment": "#565f74", "--syn-literal": "#c79bd8" } },
  "one-dark": { label: "One Dark", scheme: "dark", vars: {
    "--ground": "#282c34", "--panel": "#21252b", "--panel-edge": "#3a3f4b",
    "--ink": "#abb2bf", "--muted": "#5c6370", "--accent": "#61afef", "--accent-ink": "#10151b",
    "--syn-keyword": "#c678dd", "--syn-string": "#98c379", "--syn-number": "#d19a66",
    "--syn-comment": "#5c6370", "--syn-literal": "#56b6c2" } },
  "dracula": { label: "Dracula", scheme: "dark", vars: {
    "--ground": "#282a36", "--panel": "#21222c", "--panel-edge": "#44475a",
    "--ink": "#f8f8f2", "--muted": "#6272a4", "--accent": "#bd93f9", "--accent-ink": "#171522",
    "--syn-keyword": "#ff79c6", "--syn-string": "#f1fa8c", "--syn-number": "#bd93f9",
    "--syn-comment": "#6272a4", "--syn-literal": "#bd93f9" } },
  "monokai": { label: "Monokai", scheme: "dark", vars: {
    "--ground": "#272822", "--panel": "#1e1f1a", "--panel-edge": "#3e3d32",
    "--ink": "#f8f8f2", "--muted": "#75715e", "--accent": "#a6e22e", "--accent-ink": "#171a10",
    "--syn-keyword": "#f92672", "--syn-string": "#e6db74", "--syn-number": "#ae81ff",
    "--syn-comment": "#75715e", "--syn-literal": "#ae81ff" } },
  "github-dark": { label: "GitHub Dark", scheme: "dark", vars: {
    "--ground": "#0d1117", "--panel": "#161b22", "--panel-edge": "#30363d",
    "--ink": "#c9d1d9", "--muted": "#8b949e", "--accent": "#58a6ff", "--accent-ink": "#0b1524",
    "--syn-keyword": "#ff7b72", "--syn-string": "#a5d6ff", "--syn-number": "#79c0ff",
    "--syn-comment": "#8b949e", "--syn-literal": "#79c0ff" } },
  "github-light": { label: "GitHub Light", scheme: "light", vars: {
    "--ground": "#ffffff", "--panel": "#f6f8fa", "--panel-edge": "#d0d7de",
    "--ink": "#24292f", "--muted": "#6e7781", "--accent": "#0969da", "--accent-ink": "#ffffff",
    "--syn-keyword": "#cf222e", "--syn-string": "#0a3069", "--syn-number": "#0550ae",
    "--syn-comment": "#6e7781", "--syn-literal": "#0550ae",
    "--error": "#c43a4f", "--warn": "#8a6d0b", "--ok": "#2f7d32" } },
  "solarized-dark": { label: "Solarized Dark", scheme: "dark", vars: {
    "--ground": "#002b36", "--panel": "#073642", "--panel-edge": "#0e4956",
    "--ink": "#93a1a1", "--muted": "#586e75", "--accent": "#268bd2", "--accent-ink": "#ffffff",
    "--syn-keyword": "#859900", "--syn-string": "#2aa198", "--syn-number": "#d33682",
    "--syn-comment": "#586e75", "--syn-literal": "#b58900" } },
  "solarized-light": { label: "Solarized Light", scheme: "light", vars: {
    "--ground": "#fdf6e3", "--panel": "#eee8d5", "--panel-edge": "#d9d2c0",
    "--ink": "#657b83", "--muted": "#93a1a1", "--accent": "#268bd2", "--accent-ink": "#ffffff",
    "--syn-keyword": "#859900", "--syn-string": "#2aa198", "--syn-number": "#d33682",
    "--syn-comment": "#93a1a1", "--syn-literal": "#b58900",
    "--error": "#c43a4f", "--warn": "#8a6d0b", "--ok": "#2f7d32" } },
  "nord": { label: "Nord", scheme: "dark", vars: {
    "--ground": "#2e3440", "--panel": "#272c36", "--panel-edge": "#434c5e",
    "--ink": "#d8dee9", "--muted": "#616e88", "--accent": "#88c0d0", "--accent-ink": "#142226",
    "--syn-keyword": "#81a1c1", "--syn-string": "#a3be8c", "--syn-number": "#b48ead",
    "--syn-comment": "#616e88", "--syn-literal": "#b48ead" } },
  "gruvbox-dark": { label: "Gruvbox Dark", scheme: "dark", vars: {
    "--ground": "#282828", "--panel": "#1d2021", "--panel-edge": "#504945",
    "--ink": "#ebdbb2", "--muted": "#928374", "--accent": "#fabd2f", "--accent-ink": "#1d1a10",
    "--syn-keyword": "#fb4934", "--syn-string": "#b8bb26", "--syn-number": "#d3869b",
    "--syn-comment": "#928374", "--syn-literal": "#d3869b" } },
  "oceanic-next": { label: "Oceanic Next", scheme: "dark", vars: {
    "--ground": "#1b2b34", "--panel": "#16232a", "--panel-edge": "#343d46",
    "--ink": "#cdd3de", "--muted": "#65737e", "--accent": "#5fb3b3", "--accent-ink": "#10201f",
    "--syn-keyword": "#c594c5", "--syn-string": "#99c794", "--syn-number": "#f99157",
    "--syn-comment": "#65737e", "--syn-literal": "#f99157" } },
  "tokyo-night": { label: "Tokyo Night", scheme: "dark", vars: {
    "--ground": "#1a1b26", "--panel": "#16161e", "--panel-edge": "#2f334d",
    "--ink": "#c0caf5", "--muted": "#565f89", "--accent": "#7aa2f7", "--accent-ink": "#12162b",
    "--syn-keyword": "#bb9af7", "--syn-string": "#9ece6a", "--syn-number": "#ff9e64",
    "--syn-comment": "#565f89", "--syn-literal": "#ff9e64" } },
};

const THEME_DEFAULTS = { "--error": "#e0687a", "--warn": "#d9b45a", "--ok": "#8fbe7f" };
const themeSelect = document.getElementById("theme-select");

for (const [key, t] of Object.entries(THEMES)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = t.label;
  themeSelect.appendChild(opt);
}

function applyTheme(name) {
  const t = THEMES[name] || THEMES.writejs;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries({ ...THEME_DEFAULTS, ...t.vars })) {
    root.setProperty(k, v);
  }
  root.colorScheme = t.scheme;
  themeSelect.value = name in THEMES ? name : "writejs";
  localStorage.setItem("writejs.theme", themeSelect.value);
}

themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));

/* ---------------- format-on-save toggle ---------------- */

const fmtToggle = document.getElementById("fmt-toggle");
fmtToggle.checked = localStorage.getItem("writejs.formatOnSave") !== "0";
fmtToggle.addEventListener("change", () => {
  localStorage.setItem("writejs.formatOnSave", fmtToggle.checked ? "1" : "0");
});

/* ---------------- wiring ---------------- */

document.getElementById("btn-run").addEventListener("click", runCode);
document.getElementById("btn-format").addEventListener("click", formatCode);
document.getElementById("btn-clear").addEventListener("click", clearConsole);

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === "s") {
    e.preventDefault();
    if (fmtToggle.checked) formatCode();
    else flashStatus("auto-format is off");
  } else if (e.key === "Enter") {
    e.preventDefault();
    runCode();
  }
});

/* divider drag */
function setSplit(pct) {
  document.documentElement.style.setProperty("--editor-w", pct + "%");
}

dividerEl.addEventListener("mousedown", (e) => {
  e.preventDefault();
  dividerEl.classList.add("dragging");
  let pct = null;
  const onMove = (ev) => {
    const rect = splitEl.getBoundingClientRect();
    pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
    setSplit(pct);
  };
  const onUp = () => {
    dividerEl.classList.remove("dragging");
    if (pct !== null) localStorage.setItem("writejs.split", pct.toFixed(1));
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

/* init */
applyTheme(localStorage.getItem("writejs.theme") || "writejs");
const savedSplit = parseFloat(localStorage.getItem("writejs.split"));
if (!Number.isNaN(savedSplit)) setSplit(Math.min(80, Math.max(20, savedSplit)));
editor.value = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CODE;
refresh();
clearConsole();
editor.focus();
