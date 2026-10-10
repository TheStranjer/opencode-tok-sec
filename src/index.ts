/**
 * Server-side entry. The meter is entirely client-side; this no-op exists so
 * the package follows the documented published-plugin shape (`./tui` beside a
 * main entry) and loads cleanly from `opencode.json` as well as `cli.json`.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "tok-sec",
  setup() {},
})
