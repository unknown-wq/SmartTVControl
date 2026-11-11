/* =====================================================================
 * 36_gfx_diplomacy.js — GfxPlugins icons of the diplomacy tool (CONTRACT section 10.3). Client side, registrations only (no DOM at load time).
 *   alliance, pact, trade, gift, demand, marriage, call, embargo, vassal, tribute, release, guarantee, mail
 *   14x14 glyphs in the palette letters of Sprites (IP); the dark outline is added automatically. Light comes from the top-left.
 * ===================================================================== */

const GfxDiplomacy = (() => {
  const I = GfxPlugins.icons;

  // ---- alliance: two shields (ours blue, theirs red) side by side, a gold star where they touch
  I.alliance = (b, IP) => {
    b.art([
      'bbbbbbb.......',
      'bsssbbB.rrrrrr',
      'bsbbbbB.rmrrrR',
      'bsbbbbB.rrrrrR',
      'bbbbbbB.rrrrrR',
      '.bbbbB..rrrrR.',
      '..bbB...rrrR..',
      '...B.....rR...',
    ], IP, 0, 3);
    b.art(['..y..', '.yyy.', 'yyyyy', '.yyy.', '.y.y.'], IP, 4, 0);
    b.set(6, 2, IP.w);
  };

  // ---- pact: a parchment signed twice, sealed with a blue ribbon
  I.pact = (b, IP) => {
    b.art([
      '.tttttttttt...',
      'twwwwwwwwwwT..',
      'twkkkkkkkwwT..',
      'twwwwwwwwwwT..',
      'twkkkkkkwwwT..',
      'twwwwwwwwwwT..',
      'twkkkkkwwwwT..',
      'twwwwwwwbbbT..',
      '.TTTTTTbBBbB..',
      '.......bBssbB.',
      '........bbbb..',
      '.........b..b.',
    ], IP, 0, 1);
    b.set(10, 9, IP.w); b.set(11, 9, IP.s);
  };

  // ---- trade: goods go one way, gold the other (two opposite arrows around a coin)
  I.trade = (b, IP) => {
    b.art([
      '.......o......',
      '.......oo.....',
      'yyyyyyyyoo....',
      'yyyyyyyyyoo...',
      'YYYYYYYYoo....',
      '.......oo.....',
      '.......o......',
    ], IP, 0, 0);
    b.art([
      '......c.......',
      '.....cc.......',
      '....cc.bbbbbbb',
      '...ccbbbbbbbbb',
      '....cc.BBBBBBB',
      '.....cc.......',
      '......c.......',
    ], IP, 0, 7);
  };

  // ---- gift: a red box, a gold ribbon cross and a bow
  I.gift = (b, IP) => {
    b.art([
      '...yy..yy.....',
      '..yYYy.yYYy...',
      '..yY.yyy.Yy...',
      '...yyyyyyy....',
      '.rrrryyyrrrr..',
      '.rmmrryyrrrR..',
      '.yyyyyyyyyyy..',
      '.rmmrryyrrrR..',
      '.rmrrryyrrrR..',
      '.rrrrryyrrrR..',
      '.RRRRRyyRRRR..',
    ], IP, 0, 1);
  };

  // ---- demand: an ultimatum — a clenched fist raised in the air
  I.demand = (b, IP) => {
    b.art([
      '...ffff.ffff..',
      '..fFffFffFffF.',
      '..ffffffffffF.',
      '..fFffFffFffF.',
      '..ffffffffffF.',
      '..fffffffffFF.',
      '.fFfffffffFFF.',
      '.ffFffffffFF..',
      '..fFfffffFF...',
      '...rrrrrrrr...',
      '...rRrrrrRr...',
      '...RRRRRRRR...',
    ], IP, 0, 1);
    b.hline(2, 4, 10, IP.F);
  };

  // ---- marriage: two golden rings and a pink heart above them
  I.marriage = (b, IP, H) => {
    H.ring(b, 4.5, 9, 2.1, 3.9, IP.H); H.ring(b, 9.5, 9, 2.1, 3.9, IP.y);
    b.set(2, 7, IP.w); b.set(3, 6, IP.w); b.set(7, 7, IP.w); b.set(8, 6, IP.w);
    H.ring(b, 4.5, 9, 3.2, 3.9, IP.Y);
    b.art(['.rr.rr.', 'rmrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'], IP, 4, 0);
  };

  // ---- call to arms: a golden war horn, mouthpiece low-left, bell up-right, three blasts of sound
  I.call = (b, IP) => {
    for (let i = 0; i <= 9; i++) {
      const x = 1.5 + i * 0.85, y = 12 - i * 0.95, r = 0.9 + i * 0.2;
      b.disc(x, y, r, IP.Y); b.disc(x - 0.4, y - 0.5, Math.max(0.4, r - 0.8), IP.H);
    }
    b.disc(9.2, 4.2, 3.1, IP.Y); b.disc(9.4, 4.0, 2.4, IP.N); b.disc(9.1, 3.6, 1.6, IP.d);
    b.line(5, 7, 7, 9, IP.R); b.line(4, 8, 6, 10, IP.r);
    b.set(11, 1, IP.w); b.set(12, 2, IP.w); b.set(13, 4, IP.w); b.set(12, 6, IP.w);
    b.set(10, 0, IP.W); b.set(13, 0, IP.w);
  };

  // ---- embargo: a crate under a red prohibition sign
  I.embargo = (b, IP, H) => {
    b.art([
      'nnnnnnnnnnnn..',
      'ntttttttttTn..',
      'nNNNNNNNNNNn..',
      'ntttnttnttTn..',
      'ntttnttnttTn..',
      'nNNNNNNNNNNn..',
      'nnnnnnnnnnnn..',
    ], IP, 1, 6);
    H.ring(b, 7, 6, 4.3, 6.2, IP.r);
    b.line(3, 10, 11, 2, IP.r); b.line(4, 10, 12, 2, IP.r); b.line(3, 9, 10, 2, IP.R);
  };

  // ---- vassal: a great gold crown over a small silver one
  I.vassal = (b, IP) => {
    b.art([
      'y.....y.....y.',
      'yy...yyy...yy.',
      'yyy.yyyyy.yyy.',
      'yyyyyyyyyyyyy.',
      'yYyyyyrryyyYy.',
      'YYYYYYYYYYYYY.',
    ], IP, 0, 0);
    b.art([
      'g...g...g',
      'gg.ggg.gg',
      'ggggggggg',
      'gGgbbbgGg',
      'GGGGGGGGG',
    ], IP, 2, 8);
  };

  // ---- tribute: a tied sack with a gold coin
  I.tribute = (b, IP) => {
    b.art([
      '....nnnn......',
      '...nNnnNn.....',
      '....nrrn......',
      '...nnnnnn.....',
      '..ntttttTn.yy.',
      '.nttttttttTyYy',
      '.ntttyyyttTyYy',
      '.nttyYYYyttTyy',
      '.ntttyYyttTN..',
      '..nttttttTN...',
      '...nnnnnnN....',
    ], IP, 0, 2);
  };

  // ---- release: a chain with a broken link
  I.release = (b, IP, H) => {
    H.ring(b, 3.5, 7, 1.6, 3.4, IP.g); H.ring(b, 10.5, 7, 1.6, 3.4, IP.g);
    b.set(2, 5, IP.w); b.set(9, 5, IP.w);
    b.line(6, 3, 8, 6, IP.y); b.line(8, 6, 6, 8, IP.y); b.line(6, 8, 8, 11, IP.y);
    b.set(6, 5, IP.o); b.set(7, 9, IP.o);
  };

  // ---- guarantee: a blue shield sheltering a gold crown
  I.guarantee = (b, IP) => {
    b.art([
      'bbbbbbbbbbbb',
      'bssbbbbbbbbB',
      'bsbbbyybbbbB',
      'bsbbyyyybbbB',
      'bsbbyYYyybbB',
      'bbbbbbbbbbbB',
      '.bbbbbbbbbB.',
      '..bbbbbbbB..',
      '...bbbbbB...',
      '....bbBB....',
    ], IP, 1, 2);
    b.art(['y.y.y', 'yyyyy', 'YYYYY'], IP, 5, 4);
  };

  // ---- mail: a sealed letter (the inbox of proposals)
  I.mail = (b, IP) => {
    b.art([
      'wwwwwwwwwwww',
      'wWwwwwwwwwWw',
      'wgWwwwwwwWgw',
      'wwgWwwwwWgww',
      'wwwgWwwWgwww',
      'wwwwgrrgwwww',
      'wwwwwrRrwwww',
      'wwwwwwrrwwww',
      'WwwwwwwwwwwW',
      'WWWWWWWWWWWW',
    ], IP, 1, 2);
    b.set(6, 7, IP.m);
  };
  return { icons: ['alliance', 'pact', 'trade', 'gift', 'demand', 'marriage', 'call', 'embargo', 'vassal', 'tribute', 'release', 'guarantee', 'mail'] };
})();
