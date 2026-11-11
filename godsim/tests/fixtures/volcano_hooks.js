// Test hook for tests/power_volcano.test.mjs (appended inside the game scope with build.mjs --extra): exposes the plugin objects to the page.
if (typeof window !== 'undefined') window.__volc = { PowerVolcano, GfxVolcano, Sprites, GfxPlugins };
