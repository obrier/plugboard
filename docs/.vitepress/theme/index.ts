import { h, ref } from "vue";
import DefaultTheme from "vitepress/theme";
import "./brand.css";

const command = "brew install obrier/tap/plugboard";

// The landing page's install line, under the home hero's buttons.
const Install = {
  setup() {
    const copied = ref(false);
    const copy = () => navigator.clipboard.writeText(command).then(() => { copied.value = true; setTimeout(() => (copied.value = false), 1500); });
    return () => h("div", { class: "pb-install" }, [h("span", { class: "p", "aria-hidden": "true" }, "$"), h("code", command), h("button", { type: "button", onClick: copy }, copied.value ? "Copied" : "Copy")]);
  },
};

export default { extends: DefaultTheme, Layout: () => h(DefaultTheme.Layout, null, { "home-hero-actions-after": () => h(Install) }) };
