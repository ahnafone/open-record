import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import { rehypeDocsLinks } from './plugins/rehype-docs-links.mjs';

// GitHub Pages project site: https://ahnafone.github.io/open-record/
export default defineConfig({
  site: 'https://ahnafone.github.io',
  base: '/open-record/',
  trailingSlash: 'always',
  output: 'static',
  build: {
    format: 'directory',
  },
  markdown: {
    processor: unified({
      rehypePlugins: [[rehypeDocsLinks, { dropFirstH1: true }]],
    }),
  },
  devToolbar: { enabled: false },
});
