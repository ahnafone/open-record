// Makes Markdown rendered from the repo's docs/ folder work on the site.
// - Relative links to repo files (../README.md, ../supabase/...) become GitHub URLs on
//   main, because those files are not published with the site.
// - With dropFirstH1 the first H1 is removed: the page supplies its own H1.

const REPO = 'https://github.com/ahnafone/open-record';

function isExternalOrSpecial(href) {
  return href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function rewriteHref(href) {
  if (isExternalOrSpecial(href)) return href;
  const hashIndex = href.indexOf('#');
  const pathPart = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  // Resolve against docs/ inside the repo, e.g. ../README.md -> README.md.
  const segments = ['docs'];
  for (const part of pathPart.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return href;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  if (segments.length === 0) return href;
  const trailing = pathPart.endsWith('/') ? '/' : '';
  const kind = trailing ? 'tree' : 'blob';
  return `${REPO}/${kind}/main/${segments.join('/')}${trailing}${hash}`;
}

function walk(node, visitor) {
  visitor(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visitor);
  }
}

export function rehypeDocsLinks(options = {}) {
  return (tree) => {
    if (options.dropFirstH1) {
      const index = tree.children.findIndex((child) => child.type === 'element' && child.tagName === 'h1');
      if (index !== -1) tree.children.splice(index, 1);
    }
    walk(tree, (node) => {
      if (node.type === 'element' && node.tagName === 'a' && node.properties && typeof node.properties.href === 'string') {
        node.properties.href = rewriteHref(node.properties.href);
      }
    });
  };
}
