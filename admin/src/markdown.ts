// markdown-it is only needed for previews/originals, so it is loaded on demand (own chunk).
export const loadMarkdownPolicy = () => import('../../src/shared/markdown-policy.ts')
