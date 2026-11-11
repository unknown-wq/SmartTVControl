// Test probe for tests/power_dynamite_visual.mjs (build.mjs --extra=tests/fixtures/dynamite_probe.js): exposes the graphics plugin's draw counters + pixel builders + the plugin registry to the page.
if (typeof window !== 'undefined') window.__dynProbe = { stats: GfxDynamite.stats, build: GfxDynamite.build, NF: GfxDynamite.NF, GfxPlugins };
