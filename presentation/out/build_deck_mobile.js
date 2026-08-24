/* ==========================================================================
   presentation_mobile.pptx — мобильная (вертикальная) версия презентации
   «От „Большой Перемены“ к нейролаборатории»

   Формат 9:16 — 7,5 × 13,333″ (SPEC_MOBILE.md).
   Сетка: M = 0,42 · правый край 7,08 · низ 12,91 · колонка 6,66 · зазор 0,28.
   Контент, палитра и зоны A/B/C — из SPEC_v2.md / build_deck_v2.js без изменений.
   Кегль поднят под экран телефона: основной текст 20–24 pt, заголовки 34–40 pt.
   ========================================================================== */

const pptxgen = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "presentation_mobile.pptx");
const IMG = path.join(__dirname, "prepared", "v2r");
const RAW = path.join(__dirname, "prepared", "v2");
const BG = path.join(__dirname, "prepared", "backgrounds_mobile");
const SIZES = JSON.parse(fs.readFileSync(path.join(IMG, "sizes.json"), "utf8"));

const im = (n) => path.join(IMG, n);
const bg = (n) => path.join(BG, n + ".png");
const raw = (n) => path.join(RAW, n);
const aspect = (n) => {
  if (!SIZES[n]) throw new Error("нет размеров для " + n);
  return SIZES[n][0] / SIZES[n][1];
};

/* ── палитра (как в v2) ─────────────────────────────────────────────── */
const BLUE = "1B3C8C";
const GARNET = "8C1D3F";
const A_TINT = "F2F5FC";
const SCI = "0B69C7";
const SCI_DK = "06407A";
const GREEN = "2E9B3E";
const GREEN_DK = "1E7A2C";
const NAVY = "14315E";
const C_TINT = "F3FAEE";
const W = "FFFFFF";

const FH = "Montserrat ExtraBold";
const FB = "Montserrat";

/* ── сетка вертикального кадра ──────────────────────────────────────── */
const SW = 7.5, SH = 13.333;
const M = 0.42;
const RR = 7.08;
const BR = 12.91;
const CW = RR - M;                       // 6,66

const pres = new pptxgen();
pres.defineLayout({ name: "MOBILE9X16", width: SW, height: SH });
pres.layout = "MOBILE9X16";
pres.author = "Еременко А.М.";
pres.company = "МБОУ СОШ №12, Вышневолоцкий муниципальный округ";
pres.title = "От «Большой Перемены» к нейролаборатории — мобильная версия";

/* ── заметки докладчика: тот же разбор полного текста доклада ───────── */
const REPORT = fs.readFileSync(
  path.join(ROOT, "assets", "v2_remarks",
    "ПОЛНЫЙ ТЕКСТ ДОКЛАДА НА АВГУСТОВСКОЙ КОНФЕРЕНЦИИ.txt"), "utf8");

const HEADS = [
  /^Слайд\s*1\.\s*Титульный:\s*/,
  /^Слайд\s*2\.\s*Экосистема конкурса «Большая Перемена»\s*/,
  /^Слайд\s*3\.\s*От кейсовых заданий «Большой Перемены»-\s*к нейролаборатории\.\s*/,
  /^Слайд\s*4\.\s*Наука в школе\s*/,
  /^Слайд\s*5\s*Наши общие победы: ключевые участники проектов\s*/,
  /^Слайд\s*6\.\s*Наставник растёт вместе с учениками\.\s*/,
  /^Слайд\s*7\.\s*Проект школьных инициатив-\s*от мечты к реальности!\s*/,
  /^Слайд\s*8\s*«БиоЛаб» в работе: команда и исследования\s*/,
  /^Слайд\s*9\s*Практическая наука в «БиоЛаб»\s*/,
  /^Слайд\s*10\s*Перспективные направления\)\.\s*/,
  /^Слайд\s*11\s*Общие выводы\s*/,
];

function parseNotes() {
  const lines = REPORT.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (/^Слайд\s*\d+/.test(l.trim())) starts.push(i); });
  if (starts.length !== 11) throw new Error("ожидалось 11 разделов, найдено " + starts.length);
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(from, to).map((s) => s.trim()).filter(Boolean);
    let first = block[0];
    const re = HEADS[k];
    first = re.test(first) ? first.replace(re, "") : first.replace(/^Слайд\s*\d+[.)\s]*/, "");
    const rest = block.slice(1);
    const all = (first.trim() ? [first.trim()] : []).concat(rest);
    out.push(all.join("\n\n"));
  }
  return out;
}
const NOTES = parseNotes();

/* ── помощники вёрстки ─────────────────────────────────────────────── */
const soft = (color = "8FA3C4", opacity = 0.28) =>
  ({ type: "outer", color, blur: 9, offset: 2, angle: 90, opacity });

let screens = 0;

/**
 * Экран. slideNo — номер исходного слайда (1–11), cont — продолжение слайда.
 * Полная заметка кладётся на первый экран слайда, на продолжениях — пометка.
 */
function screen(bgName, slideNo, cont = false, contColor = BLUE) {
  const s = pres.addSlide();
  s.background = { color: W };
  s.addImage({ path: bg(bgName), x: 0, y: 0, w: SW, h: SH });
  s.addNotes(cont ? "продолжение слайда " + slideNo : NOTES[slideNo - 1]);
  if (cont) {
    s.addShape(pres.ShapeType.roundRect, {
      x: M, y: 0.14, w: 2.05, h: 0.42, rectRadius: 0.21,
      fill: { color: W }, line: { color: contColor, width: 1.25 },
    });
    s.addText("продолжение", {
      x: M, y: 0.14, w: 2.05, h: 0.42, fontFace: FB, fontSize: 17, bold: true,
      color: contColor, align: "center", valign: "middle", margin: 0,
    });
  }
  screens += 1;
  return s;
}

function title(s, text, o = {}) {
  s.addText(text, {
    x: o.x ?? M, y: o.y ?? 0.30, w: o.w ?? CW, h: o.h ?? 1.45,
    fontFace: FH, fontSize: o.size ?? 36, color: o.color ?? BLUE,
    align: o.align ?? "left", valign: "top", margin: 0,
    lineSpacingMultiple: o.ls ?? 0.98,
  });
}

function card(s, x, y, w, h, o = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: o.radius ?? 0.14,
    fill: { color: o.fill ?? W },
    line: o.line === null ? { type: "none" }
      : { color: o.line ?? BLUE, width: o.lw ?? 1.5 },
    ...(o.shadow === false ? {} : { shadow: soft(o.shadowColor, o.shadowOpacity) }),
  });
}

function chip(s, x, y, w, h, text, o = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: h / 2,
    fill: { color: o.fill ?? BLUE },
    line: o.line ? { color: o.line, width: o.lw ?? 1.25 } : { type: "none" },
  });
  s.addText(text, {
    x: x + 0.10, y, w: w - 0.20, h,
    fontFace: o.face ?? FB, fontSize: o.size ?? 18, bold: o.bold ?? true,
    color: o.color ?? W, align: "center", valign: "middle", margin: 0,
    lineSpacingMultiple: 0.94,
  });
}

function txt(s, text, o) {
  s.addText(text, {
    fontFace: o.face ?? FB, fontSize: o.size ?? 21, bold: o.bold ?? false,
    color: o.color ?? NAVY, align: o.align ?? "left", valign: o.valign ?? "top",
    margin: 0, lineSpacingMultiple: o.ls ?? 1.05,
    x: o.x, y: o.y, w: o.w, h: o.h,
  });
}

function bullets(s, items, o) {
  const runs = items.map((t, i) => ({
    text: t,
    options: {
      bullet: { indent: o.indent ?? 14 }, breakLine: true,
      paraSpaceAfter: i === items.length - 1 ? 0 : (o.gap ?? 7),
    },
  }));
  s.addText(runs, {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fontFace: o.face ?? FB, fontSize: o.size ?? 21, bold: o.bold ?? false,
    color: o.color ?? NAVY, align: "left", valign: "top", margin: 0,
    lineSpacingMultiple: o.ls ?? 1.02,
  });
}

function imgW(s, name, x, y, w) {
  const h = w / aspect(name);
  s.addImage({ path: im(name), x, y, w, h });
  return h;
}

function caption(s, text, o) {
  s.addText(text, {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fontFace: FB, fontSize: o.size ?? 18, bold: o.bold ?? true,
    color: o.color ?? NAVY, align: o.align ?? "left", valign: o.valign ?? "top",
    margin: 0, lineSpacingMultiple: 0.98,
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАН 1 — слайд 1, титульный (зона A)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = screen("bg_a_title", 1);

  s.addImage({ path: path.join(__dirname, "prepared", "slides1-4", "s1_logo_bp.png"),
    x: M, y: 0.30, w: 1.50, h: 1.50 * 160 / 325 });

  card(s, 2.10, 0.28, 4.98, 0.84, { line: BLUE, lw: 1.25 });
  txt(s, "Муниципальное бюджетное общеобразовательное учреждение " +
         "средняя общеобразовательная школа №12", {
    x: 2.22, y: 0.32, w: 4.74, h: 0.76, size: 17, bold: true,
    color: BLUE, align: "center", valign: "middle", ls: 0.96 });

  txt(s, "От „Большой Перемены“\nк нейролаборатории", {
    x: M, y: 1.25, w: CW, h: 1.90, face: FH, size: 36, color: BLUE, ls: 0.98 });

  card(s, M, 3.30, CW, 2.20, { fill: GARNET, line: GARNET, shadowColor: "6E1732" });
  txt(s, "Эффективные практики в решении метапредметных задач: от теории к практике. " +
         "Как школьные инициативы трансформируются в высокотехнологичную " +
         "образовательную среду", {
    x: M + 0.24, y: 3.42, w: CW - 0.48, h: 1.96, size: 19, bold: true, color: W });

  [
    "«Большая Перемена» — с марта 2020 года",
    "«Всероссийский атлас почвенных микроорганизмов»",
    "«БиоЛаб» — биосигналы и нейротехнологии",
  ].forEach((t, i) => chip(s, M, 5.68 + i * 0.72, CW, 0.60, t,
    { fill: GARNET, line: W, lw: 1.25, size: 18 }));

  imgW(s, "s1_school.png", M + (CW - 6.00) / 2, 7.92, 6.00);   // 6,00 × 3,320

  card(s, M, 11.40, CW, 0.72, { line: BLUE });
  txt(s, "Еременко А.М., учитель биологии МБОУ СОШ №12", {
    x: M + 0.12, y: 11.40, w: CW - 0.24, h: 0.72, size: 19, bold: true, color: BLUE,
    align: "center", valign: "middle" });

  chip(s, M, 12.25, CW, 0.58, "Вышневолоцкий муниципальный округ, 2026 год",
    { fill: BLUE, size: 19 });
}


/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 2–3 — слайд 2, экосистема конкурса «Большая Перемена» (зона A)
   ══════════════════════════════════════════════════════════════════════ */
const S2_TITLE = "Экосистема конкурса «Большая Перемена»";
{
  const s = screen("bg_a_plain", 2);
  title(s, S2_TITLE, { size: 36, h: 1.30 });

  [
    ["14", "уникальных «Вызовов»"],
    ["2020", "в движении с марта 2020 года"],
    ["7", "сезон конкурса идёт сейчас"],
  ].forEach(([num, lab], i) => {
    const y = 1.80 + i * 2.33;
    card(s, M, y, CW, 2.05, { line: BLUE });
    txt(s, num, { x: M + 0.22, y, w: 2.20, h: 2.05, face: FH, size: 58,
      color: GARNET, valign: "middle" });
    txt(s, lab, { x: M + 2.52, y, w: CW - 2.74, h: 2.05, size: 22, bold: true,
      color: BLUE, valign: "middle", ls: 1.0 });
  });

  card(s, M, 8.80, CW, 3.60, { fill: BLUE, line: BLUE, shadowColor: "12285E" });
  s.addText([
    { text: "Встречи с первыми лицами государства, космонавтами, олимпийскими " +
        "чемпионами · Росатом · Роскосмос · Сбер",
      options: { breakLine: true, fontSize: 21, bold: true, paraSpaceAfter: 12 } },
    { text: "Технологии 4К: креативность · коммуникабельность · критическое " +
        "мышление · кооперация",
      options: { fontSize: 22, fontFace: FH } },
  ], { x: M + 0.28, y: 8.94, w: CW - 0.56, h: 3.32, fontFace: FB, color: W,
    align: "left", valign: "middle", margin: 0, lineSpacingMultiple: 1.04 });
}
{
  const s = screen("bg_a_plain", 2, true, BLUE);
  title(s, S2_TITLE, { size: 36, y: 0.66, h: 1.30 });

  [
    ["Сохраняй природу!", "экология, природоохранные и исследовательские проекты"],
    ["Твори!", "творческие треки, презентации и медиапроекты"],
    ["Открывай новое!", "наука, технологии и открытия вместе с наставником"],
  ].forEach(([name, desc], i) => {
    const y = 2.20 + i * 3.30;
    card(s, M, y, CW, 3.00, { fill: GARNET, line: GARNET, shadowColor: "6E1732" });
    s.addShape(pres.ShapeType.ellipse, { x: M + 0.26, y: y + 0.24, w: 0.72, h: 0.72,
      fill: { color: W }, line: { type: "none" } });
    txt(s, String(i + 1), { x: M + 0.26, y: y + 0.24, w: 0.72, h: 0.72, face: FH,
      size: 24, color: GARNET, align: "center", valign: "middle" });
    txt(s, "«" + name + "»", { x: M + 1.14, y: y + 0.20, w: CW - 1.40, h: 0.86,
      face: FH, size: 28, color: W, valign: "middle" });
    txt(s, desc, { x: M + 0.26, y: y + 1.24, w: CW - 0.52, h: 1.60, size: 21,
      bold: true, color: W, ls: 1.04 });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАН 4 — слайд 3, победители «Большой Перемены» (зона A)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = screen("bg_a_timeline", 3);
  title(s, "От кейсовых заданий «Большой Перемены» — к нейролаборатории",
    { size: 34, h: 1.80 });

  [
    { img: "s3_zhilkina.png", year: "2020", name: "Ванесса Жилкина",
      main: "2020 год — Победитель", sub: "Первый победитель школы" },
    { img: "s3_grichenko.png", year: "2021", name: "Александр Гриченко",
      main: "2021, 2022 год — Победитель", sub: "Дарит школе световой микроскоп, 2022 год" },
    { img: "s3_zhukova.png", year: "2024", name: "Алёна Жукова",
      main: "2024 год — Абсолютный победитель, Лауреат I степени",
      sub: "2023, 2025 год — Призёр" },
  ].forEach((it, i) => {
    const y = 2.20 + i * 3.45;
    card(s, M, y, CW, 3.20, { line: BLUE });
    imgW(s, it.img, M + 0.18, y + 0.18, 2.10);               // 2,10 × 2,80
    const cx = M + 2.54, cwid = RR - 0.20 - cx;
    txt(s, it.name, { x: cx, y: y + 0.22, w: cwid, h: 0.60, face: FH, size: 24,
      color: BLUE, valign: "middle" });
    card(s, cx, y + 0.92, cwid, 1.06,
      { fill: GARNET, line: GARNET, shadowColor: "6E1732" });
    txt(s, it.main, { x: cx + 0.14, y: y + 0.92, w: cwid - 0.28, h: 1.06, size: 19,
      bold: true, color: W, align: "center", valign: "middle", ls: 0.98 });
    card(s, cx, y + 2.10, cwid, 0.88,
      { fill: A_TINT, line: BLUE, lw: 1.25, shadow: false });
    txt(s, it.sub, { x: cx + 0.14, y: y + 2.10, w: cwid - 0.28, h: 0.88, size: 17,
      bold: true, color: BLUE, align: "center", valign: "middle", ls: 0.96 });
    s.addShape(pres.ShapeType.ellipse, { x: M + 0.06, y: y + 0.06, w: 0.80, h: 0.80,
      fill: { color: GARNET }, line: { color: W, width: 2 } });
    txt(s, it.year, { x: M + 0.06, y: y + 0.06, w: 0.80, h: 0.80, face: FH, size: 17,
      color: W, align: "center", valign: "middle" });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 5–7 — слайд 4, наука в школе (зона B)
   ══════════════════════════════════════════════════════════════════════ */
const S4_TITLE = "Наука в школе: исследования учеников";
{
  const s = screen("bg_b_micro", 4);
  title(s, S4_TITLE, { size: 36, color: SCI_DK, h: 1.80 });

  card(s, M, 2.10, CW, 2.50, { fill: SCI, line: SCI, shadowColor: "05365F" });
  txt(s, "30+", { x: M + 0.24, y: 2.18, w: 2.20, h: 1.30, face: FH, size: 60,
    color: W, valign: "middle" });
  txt(s, "учеников — научные волонтёры, гражданские учёные и соавторы Атласа", {
    x: M + 2.60, y: 2.24, w: CW - 2.84, h: 2.20, size: 21, bold: true, color: W });
  chip(s, M + 0.24, 3.62, 2.20, 0.54, "2022–2024", { fill: W, color: SCI, size: 18 });

  card(s, M, 4.85, CW, 3.65, { line: SCI });
  txt(s, "Партнёрство и программа", { x: M + 0.24, y: 4.99, w: CW - 0.48, h: 0.52,
    face: FH, size: 24, color: SCI_DK });
  txt(s, "Осенью 2022 года — партнёрство с ФГАОУ ВО «Новосибирский национальный " +
         "исследовательский государственный университет» и вступление в программу " +
         "ИХБФМ СО РАН «Всероссийский атлас почвенных микроорганизмов»", {
    x: M + 0.24, y: 5.61, w: CW - 0.48, h: 2.70, size: 21, color: SCI_DK });

  card(s, M, 8.75, CW, 3.40, { line: SCI });
  txt(s, "Технологическая база", { x: M + 0.24, y: 8.89, w: CW - 0.48, h: 0.52,
    face: FH, size: 24, color: SCI_DK });
  txt(s, "Получены исследовательские наборы, цифровые инструменты и образовательные " +
         "ресурсы. Работа учеников переведена в плоскость доказательной науки", {
    x: M + 0.24, y: 9.51, w: CW - 0.48, h: 1.90, size: 21, color: SCI_DK });
  chip(s, M + 0.24, 11.49, CW - 0.48, 0.56, "ИХБФМ СО РАН · НГУ", { fill: SCI, size: 18 });
}

const S4_PHOTOS = [
  ["s4_starter_kit.png", "Стартовый набор «Охотники за микробами» и образцы почв"],
  ["s4_diplomy_atlas.png", "Дипломы наставника Еременко А.М. и соавторов " +
    "«Всероссийского атласа почвенных микроорганизмов», 2022 год"],
  ["s4_nagrazhdenie_2024.png", "Награждение гражданских учёных, волонтёров науки, " +
    "соавторов «Всероссийского атласа почвенных микроорганизмов», 2024 год"],
  ["s4_shtammy_ihbfm.png", "Штаммы выделенных почвенных бактерий перед отправкой " +
    "в ИХБФМ СО РАН, 2023 год"],
];
for (let part = 0; part < 2; part++) {
  const s = screen("bg_b_micro", 4, true, SCI_DK);
  title(s, S4_TITLE, { size: 36, color: SCI_DK, y: 0.66, h: 1.80 });
  S4_PHOTOS.slice(part * 2, part * 2 + 2).forEach(([file, cap], i) => {
    const y = 2.55 + i * 5.20;
    card(s, M, y, CW, 5.00, { line: SCI, lw: 1.25 });
    const iw = 4.50;
    imgW(s, file, M + (CW - iw) / 2, y + 0.16, iw);           // 4,50 × 3,38
    caption(s, cap, { x: M + 0.24, y: y + 3.70, w: CW - 0.48, h: 1.14, size: 18,
      color: SCI_DK });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 8–11 — слайд 5, ключевые участники проектов (зона C)
   один участник на экран: портрет крупно, достижения кеглем 22 pt
   ══════════════════════════════════════════════════════════════════════ */
const S5_TITLE = "Наши общие победы: ключевые участники проектов";
const PEOPLE = [
  {
    img: "s5_zhukova.png", name: "Алёна Жукова",
    side: ["s5_circ_azoto.png", "s5_ins_kult.png"],
    lines: [
      "«Большая Перемена»: 2024 — Абсолютный победитель, Лауреат I степени; призёр 2023 и 2025",
      "«Большие Вызовы» 2022–2023 — победитель регионального трека; тема: скрининг азотфиксирующих бактерий, Azotobacter",
      "2× победитель НПК (Базарный Карабулак); финалист «Экопоколения»; амбассадор юннатского движения",
    ],
  },
  {
    img: "s5_kolyaskina.png", name: "Ульяна Коляскина", side: ["s5_circ_strep.png"],
    lines: [
      "Призёр регионального трека «Больших Вызовов» 2023–2024; агропромышленные и биотехнологии",
      "Тема: поиск продуцентов природных антибиотиков, штаммы Streptomyces",
      "Призёр Всероссийской метапредметной НПК (Базарный Карабулак)",
    ],
  },
  {
    img: "s5_petrova.png", name: "Софья Петрова", side: [],
    lines: [
      "Финалист Всероссийского конкурса «Большая Перемена» (2022 г.)",
      "Победитель регионального трека «АгроНТИ-2022», направление «АгроРоботы»",
      "Освоила управление роботами с нуля по видеоурокам",
    ],
  },
  {
    img: "s5_elizarova.png", name: "Вероника Елизарова", side: [],
    lines: [
      "Абсолютный победитель регионального этапа Всероссийского конкурса презентаций «Многоликая Россия» (2026 г.)",
      "Номинация: Дальневосточный федеральный округ",
      "Презентация «Тункинский национальный парк»",
    ],
  },
];

PEOPLE.forEach((p, k) => {
  const cont = k > 0;
  const s = screen("bg_c_micro", 5, cont, NAVY);
  title(s, S5_TITLE, { size: 34, color: NAVY, y: cont ? 0.66 : 0.30, h: 1.80 });

  const top = cont ? 2.55 : 2.10;
  const h = 11.75 - top;
  card(s, M, top, CW, h, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });

  const av = 3.00;
  s.addImage({ path: im(p.img), x: M + 0.30, y: top + 0.30, w: av, h: av });
  const sd = 1.70;
  p.side.forEach((f, i) => {
    s.addImage({ path: im(f), x: RR - 0.30 - sd, y: top + 0.30 + i * (sd + 0.20),
      w: sd, h: sd });
  });

  card(s, M + 0.24, top + 3.55, CW - 0.48, 1.15,
    { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, p.name, { x: M + 0.36, y: top + 3.55, w: CW - 0.72, h: 1.15, face: FH,
    size: 32, color: W, align: "center", valign: "middle", ls: 0.96 });

  bullets(s, p.lines, { x: M + 0.26, y: top + 5.00, w: CW - 0.52, h: h - 5.25,
    size: 22, color: NAVY, ls: 1.02, gap: 9, indent: 15 });

  card(s, M, 11.95, CW, 0.85, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Наставник проектных команд: учитель биологии Еременко А.М.", {
    x: M + 0.14, y: 11.95, w: CW - 0.28, h: 0.85, face: FH, size: 20, color: W,
    align: "center", valign: "middle", ls: 0.96 });
});

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 12–13 — слайд 6, наставник растёт вместе с учениками (зона C)
   ══════════════════════════════════════════════════════════════════════ */
const S6_TITLE = "Наставник растёт вместе с учениками";
{
  const s = screen("bg_c_cells", 6);
  title(s, S6_TITLE, { size: 36, color: NAVY, h: 1.30 });

  s.addImage({ path: raw("s6_docs_fan_20.png"), x: 0.60, y: 2.40, w: 5.60,
    h: 5.60 * 1150 / 2400 });

  const colW = 6.20;
  s.addImage({ path: raw("s6_nagrady_collage.png"), x: M + 0.23, y: 1.80, w: colW,
    h: colW * 1975 / 2286 });                                 // 6,20 × 5,357

  card(s, M, 7.35, CW, 1.90, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Благодарность Первого заместителя Руководителя Администрации Президента " +
         "Российской Федерации С. В. Кириенко — 2020, 2021, 2022 и 2024 годы", {
    x: M + 0.24, y: 7.35, w: CW - 0.48, h: 1.90, size: 20, bold: true, color: W,
    valign: "middle" });

  imgW(s, "s6_artek.png", M, 10.00, 2.20);                    // 2,20 × 1,594
  card(s, M + 2.40, 9.45, CW - 2.40, 2.70, { line: GREEN });
  txt(s, "Удостоверение о повышении квалификации ФГБОУ «Международный детский " +
         "центр „Артек“» по программе «Современные инструменты наставничества " +
         "в воспитательной деятельности образовательной организации», 36 часов", {
    x: M + 2.54, y: 9.55, w: CW - 2.68, h: 2.50, size: 17, bold: true, color: NAVY,
    ls: 0.98 });
}
{
  const s = screen("bg_c_cells", 6, true, NAVY);
  title(s, S6_TITLE, { size: 36, color: NAVY, y: 0.66, h: 1.30 });
  [
    ["s6_foto_vruchenie.png", "Вручение благодарности Первого заместителя " +
      "Руководителя Администрации Президента Российской Федерации С. В. Кириенко"],
    ["s6_foto_gruppa.png", "Групповая работа наставников победителей на " +
      "образовательной программе при решении кейсов. Почувствуй себя в роли " +
      "наставляемого"],
  ].forEach(([file, cap], i) => {
    const y = 2.20 + i * 5.40;
    const iw = 4.60;
    const ih = imgW(s, file, M + (CW - iw) / 2, y, iw);        // 4,60 × 3,44
    caption(s, cap, { x: M + 0.10, y: y + ih + 0.18, w: CW - 0.20, h: 1.70,
      size: 19, color: NAVY });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 14–16 — слайд 7, проект школьных инициатив (зона C)
   ══════════════════════════════════════════════════════════════════════ */
const S7_TITLE = "Проект школьных инициатив — от мечты к реальности!";

function block(s, x, y, w, h, head, body, size = 21) {
  card(s, x, y, w, h, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
  s.addText([
    { text: head + " ", options: { bold: true, color: GREEN_DK, fontFace: FH } },
    { text: body, options: { color: NAVY } },
  ], {
    x: x + 0.22, y: y + 0.16, w: w - 0.44, h: h - 0.32,
    fontFace: FB, fontSize: size, align: "left", valign: "top", margin: 0,
    lineSpacingMultiple: 1.02,
  });
}
{
  const s = screen("bg_c_neuro", 7);
  title(s, S7_TITLE, { size: 34, color: NAVY, h: 1.80 });

  block(s, M, 2.20, CW, 5.00, "Идея создания научной лаборатории.",
    "Идея создания научной лаборатории в кабинете биологии для формирования " +
    "экологически ответственного поведения и развития научной деятельности среди " +
    "школьников возникала неоднократно, когда ученики выполняли " +
    "научно-исследовательские проекты. Ребята участвовали в экологических " +
    "конкурсах для получения гранта на открытие лаборатории.");
  block(s, M, 7.48, CW, 4.20, "Катализатор — начало открытия.",
    "Гриченко Александр, став победителем Всероссийского конкурса «Большая " +
    "Перемена», получает премию и в 2022 году передаёт в дар современный " +
    "световой микроскоп — это стало отправной точкой на пути к открытию " +
    "школьной лаборатории.");
}
{
  const s = screen("bg_c_neuro", 7, true, NAVY);
  title(s, S7_TITLE, { size: 34, color: NAVY, y: 0.66, h: 1.80 });

  block(s, M, 2.55, CW, 4.30, "Предложение проекта и первый этап.",
    "29 ноября 2024 года Жукова Алёна, Бондаренко София на школьном этапе " +
    "конкурса «Проект школьных инициатив» представили проект «Научная " +
    "лаборатория БиоЛаб» и по результатам голосования прошли на муниципальный " +
    "этап конкурса.");
  block(s, M, 7.13, CW, 5.20, "Результат и успешная защита.",
    "На муниципальном этапе конкурса при поддержке заместителя директора по ВР " +
    "Папиной А.Н., заместителя директора по ИКТ Кулагина Артура Александровича " +
    "Жукова Алёна и Ланцев Никита успешно защищают проект, и в школе в кабинете " +
    "биологии появляется экологическое пространство с учебно-исследовательской " +
    "лабораторией биосигналов и нейротехнологий.");
}
{
  const s = screen("bg_c_neuro", 7, true, NAVY);
  title(s, S7_TITLE, { size: 34, color: NAVY, y: 0.66, h: 1.80 });

  const iw = 6.00;
  const ih1 = imgW(s, "s7_zashchita.png", M + (CW - iw) / 2, 2.55, iw);   // 6,00 × 4,00
  caption(s, "Жукова Алёна, Ланцев Никита успешно защищают проект «БиоЛаб» на " +
    "муниципальном этапе конкурса «Школьная инициатива»", {
    x: M + 0.10, y: 2.55 + ih1 + 0.20, w: CW - 0.20, h: 1.40, size: 19, color: NAVY });

  const y2 = 2.55 + ih1 + 1.85;
  const ih2 = imgW(s, "s7_biolab_room.png", M + (CW - iw) / 2, y2, iw); // 6,00 × 4,17
  caption(s, "Школьная научная лаборатория «БиоЛаб»", {
    x: M + 0.10, y: y2 + ih2 + 0.20, w: CW - 0.20, h: 0.60, size: 19, color: NAVY,
    align: "center" });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАН 17 — слайд 8, «БиоЛаб» в работе: команда и исследования (зона C)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = screen("bg_c_neuro", 8);
  title(s, "«БиоЛаб» в работе: команда и исследования",
    { size: 36, color: NAVY, h: 1.80 });

  card(s, M, 2.10, CW, 1.15, { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, "Наставник проекта: Еременко Анна Михайловна", {
    x: M + 0.14, y: 2.10, w: CW - 0.28, h: 1.15, face: FH, size: 26, color: W,
    align: "center", valign: "middle", ls: 0.96 });

  card(s, M, 3.45, CW, 5.55, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Исследователи — ученики 10 класса", {
    x: M + 0.28, y: 3.60, w: CW - 0.56, h: 0.55, face: FH, size: 24, color: W,
    valign: "middle" });
  const nw = (CW - 0.56 - 0.24) / 2;
  [
    "Владимирова Диана", "Видонов Артём", "Гужов Алексей",
    "Елизарова Вероника", "Иванова Диана", "Малышева Анастасия",
    "Рощин Алексей", "Татушенко Егор", "Тропников Иван",
  ].forEach((n, k) => {
    const x = M + 0.28 + (k % 2) * (nw + 0.24);
    const y = 4.30 + Math.floor(k / 2) * 0.88;
    s.addShape(pres.ShapeType.roundRect, { x, y, w: nw, h: 0.74, rectRadius: 0.12,
      fill: { color: "20406F" }, line: { color: "486693", width: 1 } });
    txt(s, n, { x: x + 0.14, y, w: nw - 0.28, h: 0.74, size: 20, bold: true,
      color: W, valign: "middle" });
  });

  card(s, M, 9.20, CW, 1.45, { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, "Ассистенты проекта (ученицы 5 «Б» класса): Виноградова Алиса, " +
         "Радаева София", {
    x: M + 0.22, y: 9.20, w: CW - 0.44, h: 1.45, face: FH, size: 22, color: W,
    align: "center", valign: "middle", ls: 0.98 });

  card(s, M, 10.85, CW, 1.55, { fill: W, line: GREEN_DK, lw: 2.5 });
  txt(s, "Преемственность поколений: когда старшие ученики становятся " +
         "наставниками для младших", {
    x: M + 0.22, y: 10.85, w: CW - 0.44, h: 1.55, face: FH, size: 21,
    color: GREEN_DK, align: "center", valign: "middle", ls: 0.98 });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 18–19 — слайд 9, практическая наука в «БиоЛаб» (зона C)
   ══════════════════════════════════════════════════════════════════════ */
const S9_TITLE = "Практическая наука в «БиоЛаб»";

function expCard(s, y, h, head, headH, photo, body, verdict) {
  card(s, M, y, CW, h, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
  txt(s, head, { x: M + 0.22, y: y + 0.16, w: CW - 0.44, h: headH, face: FH,
    size: 24, color: NAVY, ls: 0.98 });
  const iw = 5.40;
  const iy = y + 0.16 + headH + 0.10;
  const ih = imgW(s, photo, M + (CW - iw) / 2, iy, iw);       // 5,40 × 2,952
  const by = iy + ih + 0.22;
  txt(s, body, { x: M + 0.22, y: by, w: CW - 0.44, h: y + h - 0.86 - by,
    size: 21, color: NAVY });
  chip(s, M + 0.20, y + h - 0.76, CW - 0.40, 0.60, verdict,
    { fill: GREEN, size: 20, face: FH });
}
{
  const s = screen("bg_c_ecg", 9);
  title(s, S9_TITLE, { size: 36, color: NAVY, h: 1.30 });

  expCard(s, 1.80, 7.90, "Эксперимент №1\n«От сердца к цифре»", 1.10, "s9_ecg.png",
    "Цель: регистрация биосигналов и расчёт ЧСС.\n" +
    "Достижения: освоена техника I отведения и настройки фильтрации.\n" +
    "Результат: биосигналы переведены в точные цифровые данные.",
    "Вердикт: гипотеза подтверждена");

  card(s, M, 9.90, CW, 2.95, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Математический фундамент", { x: M + 0.22, y: 10.02, w: CW - 0.44, h: 0.60,
    face: FH, size: 22, color: W, align: "center" });
  card(s, M + 0.24, 10.70, CW - 0.48, 1.95, { fill: W, line: W, shadow: false });
  txt(s, "ЧСС = 60 / Δt", { x: M + 0.30, y: 10.82, w: CW - 0.60, h: 0.80, face: FH,
    size: 34, color: NAVY, align: "center", valign: "middle" });
  txt(s, "уд./мин, где Δt — интервал R–R в секундах", { x: M + 0.40, y: 11.70,
    w: CW - 0.80, h: 0.85, size: 19, bold: true, color: GREEN_DK, align: "center" });
}
{
  const s = screen("bg_c_ecg", 9, true, NAVY);
  title(s, S9_TITLE, { size: 36, color: NAVY, y: 0.66, h: 1.30 });

  expCard(s, 2.20, 8.35,
    "Эксперимент №2\n«Исследование адаптации сердца\nк нагрузкам»", 1.55,
    "s9_team.png",
    "Цель: динамический цифровой мониторинг и интерпретация ЭКГ.\n" +
    "Успех: лаборатория визуализировала динамическую адаптацию организма — " +
    "физическая активность вызывает закономерное сокращение кардиоинтервала.",
    "Вердикт: гипотеза подтверждена");

  card(s, M, 10.80, CW, 1.45, { fill: "1D4478", line: W, lw: 2, shadow: false });
  const cd = 0.94, ccx = M + 0.30, ccy = 11.05;
  s.addShape(pres.ShapeType.ellipse, { x: ccx, y: ccy, w: cd, h: cd,
    fill: { color: GREEN }, line: { color: W, width: 2.5 } });
  s.addShape(pres.ShapeType.triangle, { x: ccx + 0.31, y: ccy + 0.24, w: 0.36, h: 0.46,
    fill: { color: W }, line: { type: "none" }, rotate: 90 });
  txt(s, "Видеофрагмент: ребята показывают ход эксперимента и расчёты", {
    x: ccx + cd + 0.24, y: 10.80, w: CW - cd - 0.78, h: 1.45, size: 19, bold: true,
    color: W, valign: "middle" });

  chip(s, M, 12.38, CW, 0.58, "Цифровая лаборатория «Радуга»",
    { fill: GREEN, size: 19 });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 20–21 — слайд 10, перспективные направления (зона C)
   ══════════════════════════════════════════════════════════════════════ */
const S10_TITLE = "Перспективные направления";
{
  const s = screen("bg_c_split", 10);
  title(s, S10_TITLE, { size: 36, color: NAVY, h: 1.30 });

  txt(s, "В наступающем учебном году в нашей школьной лаборатории мы планируем " +
         "развивать два перспективных научно-исследовательских вектора", {
    x: M, y: 1.75, w: CW, h: 1.85, size: 21, bold: true, color: GREEN_DK });

  const CY = 3.75;
  card(s, M, CY, CW, 9.10, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
  card(s, M + 0.18, CY + 0.14, CW - 0.36, 0.85,
    { fill: GREEN, line: GREEN, shadow: false });
  txt(s, "Вектор классической биологии (5–7 классы)", {
    x: M + 0.28, y: CY + 0.14, w: CW - 0.56, h: 0.85, face: FH, size: 22, color: W,
    align: "center", valign: "middle", ls: 0.96 });
  s.addText([
    { text: "Тема: ", options: { bold: true, color: GREEN_DK, fontFace: FH } },
    { text: "«Экспериментальное исследование факторов успешной вегетативной " +
        "репродукции лимонов сортов „Лунарио“ и „Павловский“ с изучением их " +
        "морфометрических признаков»", options: { color: NAVY } },
  ], { x: M + 0.24, y: CY + 1.14, w: CW - 0.48, h: 2.20, fontFace: FB, fontSize: 21,
    margin: 0, valign: "top", lineSpacingMultiple: 1.02 });
  s.addText([
    { text: "Направленность: ", options: { bold: true, color: GREEN_DK, fontFace: FH } },
    { text: "«Сравнительный морфологический анализ, оценка регенерационного " +
        "потенциала тканей и выявление оптимальных условий экзогенной регуляции " +
        "ризогенеза»", options: { color: NAVY } },
  ], { x: M + 0.24, y: CY + 3.44, w: CW - 0.48, h: 2.20, fontFace: FB, fontSize: 21,
    margin: 0, valign: "top", lineSpacingMultiple: 1.02 });

  const lx = M + 0.30, ly = CY + 5.80, liw = 1.90;
  card(s, lx - 0.08, ly - 0.08, liw + 0.16, liw / 0.75 + 0.16,
    { fill: NAVY, line: NAVY, shadow: false });
  imgW(s, "s10_limony.png", lx, ly, liw);                     // 1,90 × 2,533
  caption(s, "Маточные кустики сортовых лимонов «Лунарио» и «Павловский» " +
    "(для экспериментов)", { x: lx + liw + 0.30, y: ly + 0.02,
    w: RR - 0.30 - (lx + liw + 0.30), h: 1.80, size: 19, color: NAVY });
  chip(s, lx + liw + 0.30, ly + 1.95, 2.60, 0.60, "5–7 классы",
    { fill: GREEN, size: 18 });
}
{
  const s = screen("bg_c_split", 10, true, NAVY);
  title(s, S10_TITLE, { size: 36, color: NAVY, y: 0.66, h: 1.30 });

  const CY = 2.20;
  card(s, M, CY, CW, 9.95, { line: NAVY, lw: 1.5, shadowColor: "8AA98C" });
  card(s, M + 0.18, CY + 0.15, CW - 0.36, 0.85,
    { fill: NAVY, line: NAVY, shadow: false });
  txt(s, "Вектор Data Science и биомедицины (9–11 классы)", {
    x: M + 0.28, y: CY + 0.15, w: CW - 0.56, h: 0.85, face: FH, size: 22, color: W,
    align: "center", valign: "middle", ls: 0.96 });
  s.addText([
    { text: "Тема: ", options: { bold: true, color: NAVY, fontFace: FH } },
    { text: "«От цифры к микромиру: нейросенсорное восприятие биологических " +
        "данных и статистический анализ (t-критерий Стьюдента / U-критерий " +
        "Манна — Уитни) в школьной лаборатории „БиоЛаб“»", options: { color: NAVY } },
  ], { x: M + 0.24, y: CY + 1.15, w: CW - 0.48, h: 2.60, fontFace: FB, fontSize: 21,
    margin: 0, valign: "top", lineSpacingMultiple: 1.02 });
  s.addText([
    { text: "Направленность: ", options: { bold: true, color: NAVY, fontFace: FH } },
    { text: "интеграция цифровой лаборатории «Радуга», проектов гражданской " +
        "науки и методов математической статистики", options: { color: NAVY } },
  ], { x: M + 0.24, y: CY + 3.80, w: CW - 0.48, h: 1.85, fontFace: FB, fontSize: 21,
    margin: 0, valign: "top", lineSpacingMultiple: 1.02 });

  [
    "t-критерий Стьюдента", "U-критерий Манна — Уитни",
    "Цифровая лаборатория «Радуга»", "Проекты гражданской науки",
  ].forEach((t, i) => {
    chip(s, M + 0.24, CY + 5.70 + i * 0.78, CW - 0.48, 0.66, t,
      { fill: i % 2 ? GREEN : NAVY, size: 19 });
  });

  card(s, M + 0.24, CY + 8.90, CW - 0.48, 0.95, { fill: C_TINT, line: GREEN, lw: 1.5,
    shadow: false });
  txt(s, "Доказательный анализ результатов прямо в школьной лаборатории", {
    x: M + 0.36, y: CY + 8.90, w: CW - 0.72, h: 0.95, face: FH, size: 20,
    color: GREEN_DK, align: "center", valign: "middle", ls: 0.96 });
}

/* ══════════════════════════════════════════════════════════════════════
   ЭКРАНЫ 22–23 — слайд 11, общие выводы (зона C, финал)
   ══════════════════════════════════════════════════════════════════════ */
const S11_TITLE = "Общие выводы";
{
  const s = screen("bg_c_final", 11);
  title(s, S11_TITLE, { size: 36, color: NAVY, h: 0.85 });

  [
    ["1", "Эффективность проектных лифтов",
      "успешное участие в конкурсах уровня «Большой Перемены» служит мощным " +
      "стартовым фундаментом для создания инновационной инфраструктуры внутри " +
      "обычной школы"],
    ["2", "Переход к доказательной науке",
      "использование цифровых лабораторий переводит уроки биологии в плоскость " +
      "доказательной науки, наглядно визуализируя скрытые физиологические процессы"],
    ["3", "Метапредметный результат",
      "работа с нейролабораторией эффективно формирует у школьников устойчивые " +
      "hard и soft skills, стирая границы между школьным экспериментом и " +
      "будущей профессией"],
  ].forEach(([n, head, body], i) => {
    const y = 1.60 + i * 3.60;
    card(s, M, y, CW, 3.35, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
    s.addShape(pres.ShapeType.ellipse, { x: M + 0.22, y: y + 0.22, w: 0.64, h: 0.64,
      fill: { color: GREEN }, line: { type: "none" } });
    txt(s, n, { x: M + 0.22, y: y + 0.22, w: 0.64, h: 0.64, face: FH, size: 21,
      color: W, align: "center", valign: "middle" });
    txt(s, head, { x: M + 1.02, y: y + 0.20, w: CW - 1.24, h: 0.72, face: FH,
      size: 22, color: GREEN_DK, valign: "middle", ls: 0.96 });
    txt(s, body, { x: M + 0.24, y: y + 1.10, w: CW - 0.48, h: 2.05, size: 21,
      color: NAVY });
  });
}
{
  const s = screen("bg_c_final", 11, true, NAVY);
  s.addImage({ path: raw("s11_docs_fan_15.png"), x: 0.35, y: 3.20, w: 6.80,
    h: 6.80 * 1150 / 2400 });
  title(s, S11_TITLE, { size: 36, color: NAVY, y: 0.66, h: 0.85 });

  card(s, M, 1.90, CW, 2.90, { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, "Победа в конкурсе — это не финал, а стартовая точка к новым " +
         "возможностям!", {
    x: M + 0.26, y: 1.90, w: CW - 0.52, h: 2.90, face: FH, size: 28, color: W,
    align: "center", valign: "middle", ls: 1.0 });

  card(s, M, 5.00, CW, 4.60, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Прежде чем сказать вам «Спасибо за внимание!», хочется сказать спасибо " +
         "администрации школы, коллегам, родителям, ученикам, всем, кто был рядом. " +
         "Кто вместе с нами радовался нашим достижениям и разделял «горечь " +
         "поражения». Кто поддерживал, советовал и помогал.", {
    x: M + 0.28, y: 5.00, w: CW - 0.56, h: 4.60, size: 21, bold: true, color: W,
    valign: "middle", ls: 1.06 });

  txt(s, "Спасибо за внимание!", { x: M, y: 10.00, w: CW, h: 1.80, face: FH,
    size: 46, color: NAVY, align: "center", valign: "middle" });
}

/* ── запись ────────────────────────────────────────────────────────── */
pres.writeFile({ fileName: OUT }).then(() => {
  console.log("готово:", OUT);
  console.log("экранов:", screens, "· заметок-источников:", NOTES.length);
});
