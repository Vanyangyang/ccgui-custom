import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compile-time environment paths expand to the build machine's absolute paths.
// --remap-path-prefix rewrites file names, not these string values, so release
// code must resolve such paths at runtime. Builds rejected late by the final
// executable scan are caught here in seconds instead.
const PATH_MACRO = /\b(?:(?:std|core)::)?(option_env|env)!\s*\(\s*"(CARGO_MANIFEST_DIR|CARGO_MANIFEST_PATH|CARGO_TARGET_DIR|CARGO_WORKSPACE_DIR|OUT_DIR)"/g;
const ITEM_KEYWORD = /^(?:pub\b|fn\b|impl\b|struct\b|enum\b|union\b|mod\b|trait\b|use\b|const\b|static\b|type\b|unsafe\b|async\b|extern\b|macro_rules\b|let\b)/;

/** Returns `text` with comments blanked and `structure` with comments and literals blanked; offsets are preserved. */
export function lexRust(source) {
  const text = source.split('');
  const structure = source.split('');
  const blank = (array, from, to) => { for (let i = from; i < to; i++) if (array[i] !== '\n') array[i] = ' '; };
  let i = 0;
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(text, i, stop); blank(structure, i, stop); i = stop; continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1, j = i + 2;
      while (j < source.length && depth) {
        if (source[j] === '/' && source[j + 1] === '*') { depth++; j += 2; }
        else if (source[j] === '*' && source[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      blank(text, i, j); blank(structure, i, j); i = j; continue;
    }
    const identifierBefore = i > 0 && /[A-Za-z0-9_]/.test(source[i - 1]);
    const raw = !identifierBefore && /^(?:b|c)?r(#*)"/.exec(source.slice(i, i + 260));
    if (raw) {
      const close = `"${raw[1]}`;
      const end = source.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? source.length : end + close.length;
      blank(structure, i, stop); i = stop; continue;
    }
    if (c === '"' || (!identifierBefore && (c === 'b' || c === 'c') && next === '"')) {
      let j = source.indexOf('"', i) + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      blank(structure, i, j + 1); i = j + 1; continue;
    }
    if (c === "'" || (!identifierBefore && c === 'b' && next === "'")) {
      const start = c === "'" ? i : i + 1;
      let end = -1;
      if (source[start + 1] === '\\') {
        // Skip the escaped character itself so '\'' closes at the final quote.
        end = start + 3;
        while (end < source.length && source[end] !== "'" && source[end] !== '\n') end++;
      } else {
        const point = source.codePointAt(start + 1);
        const width = point > 0xffff ? 2 : 1;
        if (point !== undefined && source[start + 1] !== "'" && source[start + 1 + width] === "'") end = start + 1 + width;
      }
      if (end > start && source[end] === "'") { blank(structure, i, end + 1); i = end + 1; continue; }
    }
    i++;
  }
  return { text: text.join(''), structure: structure.join('') };
}

function matchingClose(structure, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[structure[open]]];
  for (let i = open + 1; i < structure.length; i++) {
    const c = structure[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) throw new Error('Unbalanced Rust delimiters');
      if (!stack.length) return i;
    }
  }
  throw new Error('Unbalanced Rust delimiters');
}

function cfgTokens(content) {
  return content.match(/"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|[(),=]/g) ?? [];
}

/** Evaluates a cfg predicate for a release build: true, false, or null when it depends on the target. */
export function releaseCfg(predicate) {
  const tokens = cfgTokens(predicate);
  let index = 0;
  const parse = () => {
    const name = tokens[index++];
    if (tokens[index] === '=') {
      const value = tokens[index + 1];
      index += 2;
      return name === 'feature' && value === '"test-harness"' ? false : null;
    }
    if (tokens[index] !== '(') return name === 'test' || name === 'debug_assertions' ? false : null;
    index++;
    const args = [];
    while (tokens[index] !== ')') {
      if (index >= tokens.length) throw new Error('Unterminated cfg predicate');
      args.push(parse());
      if (tokens[index] === ',') index++;
    }
    index++;
    if (name === 'not') return args[0] === null ? null : !args[0];
    if (name === 'all') return args.includes(false) ? false : args.every(value => value === true) ? true : null;
    if (name === 'any') return args.includes(true) ? true : args.every(value => value === false) ? false : null;
    return null;
  };
  const result = parse();
  if (index !== tokens.length) throw new Error('Unsupported cfg predicate');
  return result;
}

/** Outer attributes with the span of the item they gate out of release builds. */
function attributes(text, structure) {
  const result = [];
  for (const match of structure.matchAll(/#!?\s*\[/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchingClose(structure, open);
    const content = text.slice(open + 1, close).trim();
    const inner = match[0].startsWith('#!');
    let itemStart = close + 1;
    for (;;) {
      while (/\s/.test(structure[itemStart] ?? '')) itemStart++;
      const nested = /^#\s*\[/.exec(structure.slice(itemStart, itemStart + 64));
      if (!nested) break;
      itemStart = matchingClose(structure, itemStart + nested[0].length - 1) + 1;
    }
    const cfg = /^cfg\s*\(([\s\S]*)\)$/.exec(content);
    const gated = cfg ? releaseCfg(cfg[1]) === false : /^(?:[A-Za-z_][A-Za-z0-9_]*::)*test\s*(?:\([\s\S]*\))?$/.test(content);
    let end = itemStart;
    if (inner) {
      // An inner attribute gates its enclosing block, or the whole file at top level.
      let depth = 0;
      end = structure.length;
      for (let i = match.index - 1; i >= 0; i--) {
        if (structure[i] === '}') depth++;
        else if (structure[i] === '{' && depth-- === 0) { end = matchingClose(structure, i); break; }
      }
    } else {
      const declaration = ITEM_KEYWORD.test(structure.slice(itemStart, itemStart + 16));
      for (let i = itemStart; i < structure.length; i++) {
        const c = structure[i];
        if (c === '(' || c === '[') i = matchingClose(structure, i);
        else if (c === '{') { end = matchingClose(structure, i) + 1; break; }
        else if (c === ';' || (c === ',' && !declaration)) { end = i + 1; break; }
        else if (c === ')' || c === ']' || c === '}') { end = i; break; }
      }
    }
    result.push({ start: match.index, end, itemStart, content, inner, gated });
  }
  return result;
}

const within = (regions, index) => regions.some(region => index >= region.start && index < region.end);

function enclosingCalls(structure, text, index) {
  const stack = [];
  for (let i = 0; i < index; i++) {
    if (structure[i] === '(') stack.push(i);
    else if (structure[i] === ')') stack.pop();
  }
  return stack.map(open => text.slice(Math.max(0, open - 16), open).replace(/\s+$/, ''));
}

// Crate roots and mod.rs own their directory; other files own a directory named
// after themselves. #[path]-loaded files resolve like mod.rs in rustc; the nested
// spelling is kept as a fallback so an unexpected layout fails rather than hides.
function moduleBases(file, kind) {
  const nested = path.join(path.dirname(file), path.basename(file, '.rs'));
  if (kind === 'root' || path.basename(file) === 'mod.rs') return [path.dirname(file)];
  return kind === 'path' ? [path.dirname(file), nested] : [nested];
}

function resolveModule(file, kind, inline, name, explicit) {
  const candidates = explicit
    ? (inline.length ? moduleBases(file, kind).map(base => path.join(base, ...inline)) : [path.dirname(file)]).map(base => path.join(base, explicit))
    : moduleBases(file, kind).flatMap(base => [path.join(base, ...inline, `${name}.rs`), path.join(base, ...inline, name, 'mod.rs')]);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`Cannot resolve Rust module ${name} declared in ${file}`);
  return found;
}

/** Scans the release module tree (crate roots and modules not gated to tests/debug builds). */
export function scanNativeBuildPaths(root, crateRoots = ['src-tauri/src/lib.rs', 'src-tauri/src/main.rs']) {
  const findings = [];
  const visited = new Set();
  const queue = crateRoots.map(relative => ({ file: path.join(root, relative), kind: 'root' })).filter(entry => fs.existsSync(entry.file));
  while (queue.length) {
    const { file, kind } = queue.shift();
    const identity = path.resolve(file).toLowerCase();
    if (visited.has(identity)) continue;
    visited.add(identity);
    const source = fs.readFileSync(file, 'utf8');
    const { text, structure } = lexRust(source);
    const attrs = attributes(text, structure);
    if (attrs.some(attr => attr.inner && attr.gated && !/[^\s]/.test(structure.slice(0, attr.start)))) continue;
    const gated = attrs.filter(attr => attr.gated);
    const inlineModules = [];
    for (const match of structure.matchAll(/\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*([;{])/g)) {
      if (within(gated, match.index)) continue;
      const declarationStart = (() => {
        const prefix = /(?:\bpub\s*(?:\([^)]*\))?\s*)?$/.exec(structure.slice(Math.max(0, match.index - 48), match.index));
        return match.index - prefix[0].length;
      })();
      const explicit = attrs.find(attr => attr.itemStart === declarationStart && /^path\s*=/.test(attr.content));
      const inline = inlineModules.filter(module => match.index > module.start && match.index < module.end).map(module => module.name);
      if (match[2] === '{') {
        const open = match.index + match[0].length - 1;
        inlineModules.push({ name: match[1], start: open, end: matchingClose(structure, open) });
        continue;
      }
      const target = explicit ? /^path\s*=\s*"([^"]+)"$/.exec(explicit.content)?.[1] : undefined;
      if (explicit && !target) throw new Error(`Unsupported path attribute in ${file}`);
      queue.push({ file: resolveModule(file, kind, inline, match[1], target), kind: target ? 'path' : 'file' });
    }
    for (const match of text.matchAll(PATH_MACRO)) {
      // Literal contents are blanked in `structure`; quoted macro text is not a call.
      if (structure[match.index] !== text[match.index] || within(gated, match.index)) continue;
      // include!(concat!(env!("OUT_DIR"), ...)) only locates a file at compile time.
      if (enclosingCalls(structure, text, match.index).some(call => /\binclude(?:_str|_bytes)?!$/.test(call))) continue;
      findings.push({ file: path.relative(root, file).split(path.sep).join('/'), line: source.slice(0, match.index).split('\n').length, macro: match[0].replace(/\s+/g, '') });
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const findings = scanNativeBuildPaths(root);
  console.log(JSON.stringify({ findings }, null, 2));
  if (findings.length) process.exitCode = 1;
}
