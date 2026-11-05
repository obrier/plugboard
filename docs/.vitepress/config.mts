import { defineConfig } from "vitepress";

// The pages are docs/ itself: plain Markdown, read the same on GitHub. VitePress lives here too, in docs/package.json.
export default defineConfig({
  srcExclude: ["design/**", "RELEASING.md", "harness-guides.md", "node_modules/**"],
  title: "Plugboard",
  description: "claude.ai connectors as shell commands and a TypeScript library",
  cleanUrls: true,
  markdown: { theme: { light: "github-dark", dark: "github-dark" } }, // the code blocks are a dark terminal in both themes
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }]],
  themeConfig: {
    logo: { light: "/mark.svg", dark: "/mark-dark.svg", alt: "" },
    nav: [{ text: "Guide", link: "/getting-started" }, { text: "Reference", link: "/reference/commands" }, { text: "npm", link: "https://www.npmjs.com/package/@obrier/plugboard" }],
    sidebar: [
      { text: "Start", items: [{ text: "Getting started", link: "/getting-started" }] },
      { text: "Guides", items: [{ text: "Writes: plan, approve, send", link: "/guides/writes" }] },
      { text: "Reference", items: [{ text: "Commands", link: "/reference/commands" }] },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/obrier/plugboard" }],
    editLink: { pattern: "https://github.com/obrier/plugboard/edit/main/docs/:path" },
  },
});
