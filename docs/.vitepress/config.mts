import { defineConfig } from "vitepress";

// The pages are docs/ itself: plain Markdown, read the same on GitHub. VitePress lives here too, in docs/package.json.
// The site is served under the landing page, at <site>/docs/: the pages workflow sets DOCS_URL from configure-pages.
const url = process.env.DOCS_URL ?? "http://localhost:4301/docs/";
const base = new URL(url).pathname;

export default defineConfig({
  base,
  srcExclude: ["design/**", "RELEASING.md", "node_modules/**"],
  title: "Plugboard",
  description: "claude.ai connectors as shell commands and a TypeScript library",
  cleanUrls: true,
  markdown: { theme: { light: "github-dark", dark: "github-dark" } }, // the code blocks are a dark terminal in both themes
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }],
    ["meta", { property: "og:image", content: new URL("og.png", url).href }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  themeConfig: {
    logo: { light: "/mark.svg", dark: "/mark-dark.svg", alt: "" },
    nav: [{ text: "Guide", link: "/getting-started" }, { text: "Reference", link: "/reference/commands" }, { text: "npm", link: "https://www.npmjs.com/package/@obrier/plugboard" }],
    sidebar: [
      { text: "Start", items: [{ text: "Getting started", link: "/getting-started" }] },
      { text: "Guides", items: [
        { text: "Use it from any agent", link: "/harness-guides" },
        { text: "Writes: plan, approve, send", link: "/guides/writes" },
        { text: "Batch", link: "/guides/batch" },
        { text: "From code", link: "/guides/library" },
      ] },
      { text: "Concepts", items: [
        { text: "How it works", link: "/concepts/how-it-works" },
        { text: "Policy and safety", link: "/concepts/safety" },
        { text: "Compared with alternatives", link: "/concepts/comparison" },
      ] },
      { text: "Reference", items: [
        { text: "Commands", link: "/reference/commands" },
        { text: "Files and environment", link: "/reference/files" },
      ] },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/obrier/plugboard" }],
    editLink: { pattern: "https://github.com/obrier/plugboard/edit/main/docs/:path" },
  },
});
