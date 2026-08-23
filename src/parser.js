'use strict';
// Parse-only symbol extraction (BR-006: no target code is ever executed).
// Heuristic line-based parsing per language family. Markdown gets a structural
// heading scan producing Document/Section/Link nodes. Vue/Svelte/Astro yield one
// component node per file with script blocks parsed as TS at real line numbers.
// SQL contributes DDL constructs only.
const path = require('node:path');

const LANG_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.swift': 'swift', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp',
  '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php', '.scala': 'scala', '.lua': 'lua',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.sql': 'sql', '.md': 'markdown',
  '.mdx': 'markdown', '.vue': 'component', '.svelte': 'component', '.astro': 'component',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.html': 'html',
  '.css': 'css', '.scss': 'css', '.less': 'css', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml', '.zig': 'zig', '.dart': 'dart',
  '.r': 'r', '.jl': 'julia', '.pl': 'perl', '.groovy': 'groovy', '.tf': 'terraform',
};

/**
 * Languages a dependency map cannot say anything about.
 *
 * Derived from the table above rather than listed a second time somewhere
 * else, so adding an extension cannot leave two answers to "is this code".
 * This gates only what the *map* draws by default; src/ignore.js decides what
 * the indexer stores, and excluding markdown there would break
 * `vnodes impact README.md`, capsule pivot resolution and the structural
 * markdown parse below.
 */
const DOC_LANGS = new Set(['markdown', 'json', 'yaml', 'toml', 'html', 'css', 'env']);

function langOf(relPath) {
  const base = path.basename(relPath);
  if (base.startsWith('.env')) return 'env'; // allowlisted examples index as env files
  return LANG_BY_EXT[path.extname(relPath).toLowerCase()] || null;
}

// --- per-family symbol patterns: [kind, regex-with-name-group] ---
const CODE_PATTERNS = {
  javascript: [
    ['function', /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/],
    ['class', /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/],
    ['function', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/],
    ['const', /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/],
    ['method', /^\s{2,}(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*$/],
  ],
  typescript: null, // alias of javascript, plus interfaces/types
  python: [
    ['function', /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/],
    ['class', /^\s*class\s+([A-Za-z_]\w*)/],
  ],
  ruby: [
    ['function', /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!]?)/],
    ['class', /^\s*class\s+([A-Z]\w*)/],
    ['module', /^\s*module\s+([A-Z]\w*)/],
  ],
  go: [
    ['function', /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)/],
    ['type', /^type\s+([A-Za-z_]\w*)/],
  ],
  rust: [
    ['function', /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/],
    ['struct', /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/],
    ['enum', /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/],
    ['trait', /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/],
    ['impl', /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([A-Za-z_][\w:]*)/],
  ],
  java: [
    ['class', /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/],
    ['method', /^\s+(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\(/],
  ],
  sql: [
    ['table', /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i],
    ['view', /^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+[`"']?([\w.]+)/i],
    ['function', /^\s*create\s+(?:or\s+replace\s+)?function\s+[`"']?([\w.]+)/i],
    ['index', /^\s*create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i],
    ['trigger', /^\s*create\s+(?:or\s+replace\s+)?trigger\s+[`"']?([\w.]+)/i],
  ],
  shell: [['function', /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/]],
  lua: [
    ['function', /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/],
    ['function', /^\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*=\s*function\b/],
  ],
  csharp: null, kotlin: null, swift: null, scala: null, // reuse java-ish
  c: [
    ['function', /^[A-Za-z_][\w\s*]*\s[*]?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/],
    ['struct', /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/],
  ],
  cpp: null, // reuse c
  php: [
    ['function', /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/],
    ['class', /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/],
  ],
};
CODE_PATTERNS.typescript = [
  ...CODE_PATTERNS.javascript,
  ['interface', /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
  ['type', /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/],
  ['enum', /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/],
];
CODE_PATTERNS.cpp = CODE_PATTERNS.c;
CODE_PATTERNS.csharp = [
  ...CODE_PATTERNS.java,
  // namespace declarations feed `using` resolution — C# namespaces have no
  // path convention, so the declaring files ARE the map.
  ['module', /^\s*namespace\s+([\w.]+)/],
];
CODE_PATTERNS.kotlin = [
  ['function', /^\s*(?:override\s+|private\s+|public\s+|internal\s+|suspend\s+)*fun\s+([A-Za-z_]\w*)/],
  ['class', /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/],
];
CODE_PATTERNS.swift = [
  ['function', /^\s*(?:public\s+|private\s+|internal\s+|static\s+|override\s+)*func\s+([A-Za-z_]\w*)/],
  ['class', /^\s*(?:public\s+|final\s+)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/],
];
CODE_PATTERNS.scala = [
  ['function', /^\s*(?:override\s+|private\s+|protected\s+)*def\s+([A-Za-z_]\w*)/],
  ['class', /^\s*(?:case\s+|abstract\s+|sealed\s+)*(?:class|trait|object)\s+([A-Za-z_]\w*)/],
];
// Dart members carry a leading return type and no access keyword, so a bare
// `Name(` is ambiguous: at method depth it is nearly always a Flutter
// widget-tree call (`Container(`, `Text(`), not a declaration. Two guards keep
// build methods from flooding the index — constructors are pinned to
// class-member indentation (2 spaces, what dartfmt emits), and functions must
// carry a return-type token, which no call site has. The statement-keyword
// lookahead then rejects `return Foo(` and friends at any depth.
CODE_PATTERNS.dart = [
  ['class', /^\s*(?:abstract\s+|base\s+|final\s+|interface\s+|sealed\s+|mixin\s+)*class\s+([A-Za-z_$][\w$]*)/],
  ['mixin', /^\s*(?:base\s+)?mixin\s+([A-Za-z_$][\w$]*)/],
  // `extension on Foo {` is anonymous — the lookahead stops `on` becoming a name.
  ['extension', /^\s*extension(?:\s+type)?\s+(?!on\b)([A-Za-z_$][\w$]*)/],
  ['enum', /^\s*enum\s+([A-Za-z_$][\w$]*)/],
  ['type', /^\s*typedef\s+([A-Za-z_$][\w$]*)/],
  // Constructors are matched in parseFile, not here — telling a declaration
  // from a `const Foo(` call in a top-level list needs the enclosing class.
  ['getter', /^\s*(?:static\s+)?[\w$][\w$<>,[\]?]*(?:\s+[\w$][\w$<>,[\]?]*)*\s+get\s+([A-Za-z_$][\w$]*)/],
  // Type tokens must start with a word char: `?` is in the class for nullables
  // (`Widget?`), and without this a ternary `? Foo(x)` reads as a declaration.
  // `Function` is Dart's function-type keyword, never a declared name.
  ['function', /^\s*(?!(?:return|await|if|for|while|switch|throw|yield|assert|else|case|new|super|this|final|const|var)\b)(?:@\w+\s+)*(?:static\s+|external\s+)*[\w$][\w$<>,[\]?]*(?:\s+[\w$][\w$<>,[\]?]*)*\s+((?!Function\b)[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/],
  // `operator ==(` puts a space and the symbol between the name and the paren,
  // so the generic `function` pattern above can never reach it. Spelling the
  // operators out instead of `\S+`, plus the required return-type token, keeps
  // call sites and expressions out.
  ['function', /^\s*(?:@\w+\s+)*(?:static\s+|external\s+)*[\w$][\w$<>,[\]?]*\s+operator\s*(==|<=|>=|<<|>>>|>>|<|>|\[\]=|\[\]|[-+*/%~^&|])\s*\(/],
  // Column-anchored so locals inside function bodies stay out of the skeleton.
  ['const', /^(?:final|const)\s+(?:[\w$<>,[\]?]+\s+)?([A-Za-z_$][\w$]*)\s*=/],
];

const IMPORT_PATTERNS = [
  /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/,          // ES modules
  /^\s*import\s+['"]([^'"]+)['"]/,                    // side-effect import
  /require\(\s*['"]([^'"]+)['"]\s*\)/,                // CJS
  /^\s*from\s+([\w.]+)\s+import\s+/,                  // python
  /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*(?:[#;].*)?$/, // python / java-ish, incl. `as` alias
  /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/,      // rust use (incl. pub use re-exports)
  /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/, // rust mod declaration (file-backed)
  /^\s*#include\s+["<]([^">]+)[">]/,                  // c/c++
  /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,     // ruby
];

function parseMarkdown(relPath, text) {
  const nodes = [{ name: path.basename(relPath), kind: 'document', line: 1, signature: relPath }];
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) nodes.push({ name: h[2].trim(), kind: 'section', line: i + 1, signature: l.trim() });
    for (const m of l.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g))
      nodes.push({ name: m[1], kind: 'link', line: i + 1, signature: m[2] });
  });
  return { nodes, imports: [] };
}

function parseComponent(relPath, text) {
  // One component node per file; script blocks parsed as TS at real line numbers.
  const nodes = [{ name: path.basename(relPath, path.extname(relPath)), kind: 'component', line: 1, signature: relPath }];
  const imports = [];
  const lines = text.split('\n');
  let inScript = false;
  lines.forEach((l, i) => {
    if (/<script[\s>]/.test(l)) { inScript = true; return; }
    if (/<\/script>/.test(l)) { inScript = false; return; }
    const inFrontmatter = relPath.endsWith('.astro');
    if (!inScript && !inFrontmatter) return;
    for (const [kind, re] of CODE_PATTERNS.typescript) {
      const m = l.match(re);
      if (m) { nodes.push({ name: m[m.length - 1], kind, line: i + 1, signature: l.trim() }); break; }
    }
    for (const re of IMPORT_PATTERNS) {
      const m = l.match(re);
      if (m) { imports.push(m[1]); break; }
    }
  });
  return { nodes, imports };
}

function parseFile(relPath, text) {
  const lang = langOf(relPath);
  if (!lang) return null;
  if (lang === 'markdown') return { lang, ...parseMarkdown(relPath, text) };
  if (lang === 'component') return { lang, ...parseComponent(relPath, text) };
  const patterns = CODE_PATTERNS[lang];
  const nodes = [];
  const imports = [];
  const lines = text.split('\n');
  // Go groups most imports in `import ( ... )` blocks whose lines are bare
  // quoted paths (optionally aliased) that no single-line pattern can see.
  let goImportBlock = false;
  // Dart: name of the innermost top-level class, to validate constructors, and
  // the delimiter of the multi-line string currently open, if any.
  let dartClass = null;
  let dartStr = null;
  lines.forEach((l, i) => {
    // A Dart constructor shares its class's name, and that is the only thing
    // separating `  const Foo(` as a declaration from the same line as a call
    // inside a top-level `const [...]` literal. Track the enclosing class and
    // require the match to name it.
    if (lang === 'dart') {
      // A codegen toolchain stores Dart source as data — templates live in raw
      // strings, so their bodies arrive here as ordinary-looking lines. Without
      // this, a template's `import` becomes a real edge and its classes become
      // real nodes. Only ''' and """ span lines, so tracking those two is enough.
      if (dartStr) { if (l.includes(dartStr)) dartStr = null; return; }
      const open = l.match(/(?:^|[^'"])(?:r)?('''|""")/);
      // An odd count leaves the delimiter open at EOL; an even count is a
      // complete single-line string. The opening line still falls through, so
      // `const String tpl = r'''` is captured as a const.
      if (open && (l.split(open[1]).length - 1) % 2 === 1) dartStr = open[1];
      // A configurable import names its alternatives in `if (dart.library.x)`
      // clauses, which may sit on continuation lines that no `^import` anchor
      // can see. Dropping them hides the variant that actually compiles on a
      // given platform — sometimes the only one that ever ships. Anchor on
      // `dart.library.` specifically: a looser `if (...) '...'` also matches
      // collection-if entries in map literals. Deliberately not returning, as
      // one directive can carry several clauses alongside its default URI.
      for (const c of l.matchAll(/\bif\s*\(\s*dart\.library\.[\w.]+\s*\)\s*['"]([^'"]+)['"]/g))
        imports.push(c[1]);
      // Barrel files wire packages together with `export`, and codegen splices
      // `.g.dart` in with `part` — both are real file dependencies that look
      // nothing like an import to the generic patterns. `part of` is skipped on
      // purpose: it restates the parent's `part` from the other side, so
      // capturing it would fabricate a reverse edge and put every generated
      // file in a 2-cycle with its source. The parent→part edge already answers
      // "who depends on this .g.dart", since impact walks edges backwards.
      const wire = l.match(/^\s*(?:export|part)\s+['"]([^'"]+)['"]/);
      if (wire) { imports.push(wire[1]); return; }
      const decl = l.match(/^(?:abstract\s+|base\s+|final\s+|interface\s+|sealed\s+|mixin\s+)*(?:class|mixin|extension|enum)\s+(?:type\s+)?(?!on\b)([A-Za-z_$][\w$]*)/);
      if (decl) dartClass = decl[1];
      else if (/^\}/.test(l)) dartClass = null; // column-0 brace closes the body
      else if (dartClass) {
        // Requiring the name to equal the enclosing class is what separates a
        // declaration from a `const Foo(` call, so the name class carries no
        // weight here: `_Foo` (the dominant private-widget idiom) and `$Foo`
        // (freezed / json_serializable output) declare constructors too.
        const c = l.match(/^ {2}(?:const\s+|factory\s+|external\s+)?([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)?)\s*\(/);
        if (c && c[1] === dartClass) {
          nodes.push({ name: c[1] + c[2], kind: 'constructor', line: i + 1, signature: l.trim().slice(0, 200) });
          return;
        }
      }
    }
    if (lang === 'go') {
      if (goImportBlock) {
        if (/^\s*\)/.test(l)) { goImportBlock = false; return; }
        const m = l.match(/^\s*(?:[\w.]+\s+)?"([^"]+)"/);
        if (m) imports.push(m[1]);
        return;
      }
      if (/^\s*import\s*\(/.test(l)) { goImportBlock = true; return; }
      const single = l.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/);
      if (single) { imports.push(single[1]); return; }
    }
    // Rust grouped use: `use prefix::{a, b as c, self}` — expand each item to
    // its full module path; the generic pattern below only sees the prefix.
    if (lang === 'rust') {
      const g = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)::\{([^}]*)\}/);
      if (g) {
        for (const raw of g[2].split(',')) {
          const item = raw.trim().split(/\s+as\s+/)[0];
          if (item === 'self' || item === '') imports.push(g[1]);
          else if (/^[\w:]+$/.test(item)) imports.push(`${g[1]}::${item}`);
        }
        return; // generic use-pattern would re-capture the prefix with trailing '::'
      }
    }
    // PHP namespaces use backslashes no generic pattern matches; requires may
    // wrap the literal in parens and a __DIR__ prefix. `use` lines carry no
    // symbols, so returning after a match loses nothing.
    if (lang === 'php') {
      const grp = l.match(/^\s*use\s+([\w\\]+)\\\{([^}]*)\}/);
      if (grp) {
        for (const raw of grp[2].split(',')) {
          const item = raw.trim().split(/\s+as\s+/i)[0];
          if (/^[\w\\]+$/.test(item)) imports.push(`${grp[1]}\\${item}`);
        }
        return;
      }
      const u = l.match(/^\s*use\s+(?:(?:function|const)\s+)?([\w\\]+)(?:\s+as\s+\w+)?\s*;/i);
      if (u) { imports.push(u[1]); return; }
      const req = l.match(/(?:require|include)(?:_once)?\s*\(?\s*(__DIR__\s*\.\s*)?['"]([^'"]+\.php)['"]/);
      if (req) { imports.push(req[1] ? `.${req[2]}` : req[2]); return; }
      // Legacy PHP wires without `use`: new X(), X::static, extends/implements.
      // These lines can also declare symbols, so no early return. The resolver's
      // unique-class guard keeps built-ins (Exception, DateTime) from edging.
      for (const m of l.matchAll(/(?:\bnew\s+|\bextends\s+|\bimplements\s+)\\?([A-Z]\w*)|\b\\?([A-Z]\w*)::/g)) {
        const name = m[1] || m[2];
        if (!['Self', 'Static', 'Parent'].includes(name)) imports.push(name);
      }
    }
    // Java/Kotlin: wildcard (`import com.foo.*;`) and static-member imports
    // fail the generic pattern's line-end check. Wildcards keep a trailing dot
    // so the resolver knows it's a package, statics drop the member segment.
    if (lang === 'java' || lang === 'kotlin') {
      const m = l.match(/^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/);
      if (m) {
        const spec = m[1] ? m[2].split('.').slice(0, -1).join('.') : m[2];
        if (spec) imports.push(m[3] ? `${spec}.` : spec);
        return;
      }
    }
    // C#: `using Foo.Bar;` (plus global/static/alias forms) is namespace-level
    // and matches no generic pattern. `using (` / `using var` never match.
    if (lang === 'csharp') {
      const m = l.match(/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/);
      if (m) { imports.push(m[1]); return; }
    }
    // Shell: `source lib.sh` / `. ./lib.sh` — path-style, resolved like a
    // relative import. Quotes optional; $VAR paths are dynamic and skipped.
    if (lang === 'shell') {
      const m = l.match(/^\s*(?:source|\.)\s+['"]?([^'"\s$]+)['"]?\s*$/);
      if (m) { imports.push(m[1]); return; }
    }
    // Swift: @testable and item imports (`import struct Foo.Bar`) escape the
    // generic pattern; capture the module reference whole.
    if (lang === 'swift') {
      const m = l.match(/^\s*(?:@testable\s+)?import\s+(?:(?:class|struct|enum|func|typealias|protocol|let|var)\s+)?([\w.]+)/);
      if (m) { imports.push(m[1]); return; }
    }
    if (patterns) {
      for (const [kind, re] of patterns) {
        const m = l.match(re);
        if (m) { nodes.push({ name: m[m.length - 1], kind, line: i + 1, signature: l.trim().slice(0, 200) }); break; }
      }
    }
    for (const re of IMPORT_PATTERNS) {
      const m = l.match(re);
      if (m) { imports.push(m[1]); break; }
    }
  });
  // Every parsed file is at least a file node so the graph covers the tree.
  if (nodes.length === 0) nodes.push({ name: path.basename(relPath), kind: 'file', line: 1, signature: relPath });
  return { lang, nodes, imports };
}

module.exports = { parseFile, langOf, LANG_BY_EXT, DOC_LANGS };
