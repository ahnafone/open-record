import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

// Repo docs are rendered at build time and never copied into the site.
// If docs/ios-install.md does not exist yet, the iphone collection is empty and the
// iPhone page falls back to a link to the guide on GitHub.
const docs = new URL('../../../docs/', import.meta.url);

const desktop = defineCollection({
  loader: glob({ pattern: 'desktop.md', base: docs }),
});

const iphone = defineCollection({
  loader: glob({ pattern: 'ios-install.md', base: docs }),
});

export const collections = { desktop, iphone };
