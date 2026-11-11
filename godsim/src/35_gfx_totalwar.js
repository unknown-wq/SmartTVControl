/* =====================================================================
 * 35_gfx_totalwar.js — graphics plugin of the TOTAL WAR feature («Вся страна»). Registrations only, no DOM at load time.
 * Icons (14x14 glyph, the dark outline is added by Sprites; palette letters: see CONTRACT §10.3):
 *   country    — a realm drawn as a cluster of parcels, one of them crowned (the «Вся страна» toggle of the war card)
 *   total_war  — crossed swords over a blaze (the red «Объявить тотальную войну» button, the HUD chip, the banner)
 *   capitulate — a white flag on a pole (the capitulation sheet and the HUD countdown)
 * Used by 23_ui.js through Sprites.icon(key, size); an unknown key would show a «?», so UI falls back to `war` / `flag_goal` if a plugin file is missing.
 * ===================================================================== */

GfxPlugins.icons.country = (b, IP) => {
  // a realm as four parcels (light / mid shades) divided by dark borders; the crown marks the capital parcel
  b.art([
    '..lllllEeeeeee.',
    '.llllllEeeeeeee',
    'lllllllEeeeeeee',
    'lllllllEeeeeeEe',
    'EEEEEEEEEEEEEEE',
    'eeeeeeEllllllll',
    'eeeeeeElllllllE',
    '.eeeeeEllllllE.',
    '..eeeeEEllllE..',
    '....eeeeEEEE...',
  ], IP, -1, 2);
  b.art([
    'y.y.y',
    'yyyyy',
    'YYYYY',
  ], IP, 8, 5);
  b.set(10, 5, IP.r);
};

GfxPlugins.icons.total_war = (b, IP) => {
  // a blaze behind two crossed swords
  b.art([
    '.......o......',
    '.....o.oo.....',
    '....oo.oyo.o..',
    '...oooooyyoo..',
    '..oooyyyyyyoo.',
    '..ooyyyyyyyoo.',
    '.ooyyyyyyyyyoo',
    '.orryyyyyyyrro',
    'orrrrryyyyrrro',
    'orrRrrrrrrrRro',
  ], IP, 0, 4);
  const blade = (flip) => {
    const X = (x) => (flip ? 13 - x : x);
    for (let t = 0; t < 9; t++) { b.set(X(1 + t), 1 + t, IP.w); b.set(X(2 + t), 1 + t, IP.W); b.set(X(1 + t), 2 + t, IP.g); }
    b.set(X(0), 0, IP.w); b.set(X(1), 0, IP.W); b.set(X(0), 1, IP.W);
    b.line(X(8), 12, X(12), 8, IP.y); b.line(X(8), 11, X(11), 8, IP.Y); b.line(X(9), 12, X(12), 9, IP.Y);
    b.line(X(10), 10, X(13), 13, IP.n); b.line(X(10), 11, X(12), 13, IP.N);
    b.set(X(13), 13, IP.y);
  };
  blade(false); blade(true);
  b.set(6, 5, IP.w); b.set(7, 5, IP.w); b.set(6, 6, IP.W); b.set(7, 6, IP.W);
};

GfxPlugins.icons.capitulate = (b, IP) => {
  // a white flag, limp, on a brown pole planted in the ground
  b.ell(4, 13, 4, 1.2, IP.G); b.ell(4, 13, 2.6, 0.7, IP.g);
  b.vline(3, 0, 13, IP.n); b.vline(4, 0, 13, IP.N);
  b.set(3, 0, IP.y); b.set(4, 0, IP.Y);
  b.art([
    'wwwwwwwWW',
    'wwwwwwWWWg',
    'wWwwwwWWgg',
    'WWwwwWWgg.',
    'WWWWWWggg.',
    '.WWWWggg..',
    '...WWgg...',
  ], IP, 5, 1);
  b.hline(5, 1, 9, IP.w);
};
