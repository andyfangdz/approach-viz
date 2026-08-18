import type { ReactNode } from 'react';

/* Minimal regex tokenizer for the handful of small, hand-authored code
   excerpts on this page (ts / rust / glsl). Not a general-purpose
   highlighter — content is controlled, so a light pass is enough. */

const KEYWORDS = {
  ts: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'new',
    'import',
    'export',
    'type',
    'interface',
    'true',
    'false',
    'null'
  ]),
  rust: new Set([
    'pub',
    'fn',
    'let',
    'mut',
    'struct',
    'impl',
    'for',
    'in',
    'if',
    'else',
    'match',
    'use',
    'mod',
    'const',
    'return',
    'true',
    'false'
  ]),
  glsl: new Set([
    'uniform',
    'varying',
    'attribute',
    'in',
    'out',
    'flat',
    'if',
    'else',
    'return',
    'precision',
    'highp',
    'true',
    'false'
  ])
};

const TYPES = {
  ts: new Set(['number', 'string', 'boolean', 'Math', 'Float32Array', 'Uint8Array']),
  rust: new Set([
    'f32',
    'f64',
    'u8',
    'u16',
    'u32',
    'i16',
    'i64',
    'usize',
    'Vec',
    'Option',
    'String',
    'Arc',
    'RwLock'
  ]),
  glsl: new Set([
    'void',
    'float',
    'int',
    'bool',
    'vec2',
    'vec3',
    'vec4',
    'mat3',
    'mat4',
    'sampler2D',
    'sampler2DArray'
  ])
} as const;

const TOKEN_RE =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d(?:[\d_]*\.?[\d_]*)(?:[eE][+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;

export function CodeHighlight({ code, lang }: { code: string; lang: string }): ReactNode {
  if (lang !== 'ts' && lang !== 'rust' && lang !== 'glsl') {
    return code;
  }
  const keywords = KEYWORDS[lang];
  const types = TYPES[lang];

  const nodes: ReactNode[] = [];
  let plain = '';
  let key = 0;
  const flush = () => {
    if (plain) {
      nodes.push(plain);
      plain = '';
    }
  };

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(code)) !== null) {
    const [full, comment, str, num, word] = m;
    let cls: string | null = null;
    if (comment) cls = 'c';
    else if (str) cls = 's';
    else if (num) cls = 'n';
    else if (word) {
      if (keywords.has(word)) cls = 'k';
      else if (types.has(word)) cls = 't';
      else if (code[TOKEN_RE.lastIndex] === '(') cls = 'f';
    }
    if (cls) {
      flush();
      nodes.push(
        <span key={key++} className={`ov-tok-${cls}`}>
          {full}
        </span>
      );
    } else {
      plain += full;
    }
  }
  flush();
  return nodes;
}
