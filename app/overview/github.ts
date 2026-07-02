const GITHUB_BASE = 'https://github.com/andyfangdz/approach-viz';
const GITHUB_BRANCH = 'master';

/* Repo-relative paths we are willing to link: top-level source dirs plus a few
   root files. Generated trees (data/, public/, .tmp/) stay unlinked. */
const REPO_PATH_RE =
  /^(?:(?:app|lib|scripts|crates|services|ios|sw|schemas|docs|packages|tools|\.agents)\/[^\s`*]*|AGENTS\.md|CLAUDE\.md|next\.config\.ts|package\.json|Cargo\.toml)$/;

/* Files referenced without a dot extension — everything else extensionless
   is treated as a directory (tree link). */
const EXTENSIONLESS_FILES = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'CODEOWNERS']);

export function githubUrlForPath(path: string): string | null {
  if (!REPO_PATH_RE.test(path)) return null;
  const clean = path.replace(/\/+$/, '');
  const last = clean.split('/').pop() ?? '';
  const isDir =
    path.endsWith('/') || (!EXTENSIONLESS_FILES.has(last) && !/\.[A-Za-z0-9]+$/.test(last));
  return `${GITHUB_BASE}/${isDir ? 'tree' : 'blob'}/${GITHUB_BRANCH}/${clean}`;
}
