/* ==========================================================================
   presentation_v2.pptx — «От „Большой Перемены“ к нейролаборатории»
   Августовская конференция 2026 · Еременко А.М., МБОУ СОШ №12
   Сборка строго по SPEC_v2.md (11 видимых слайдов, 16:9, 13,333 × 7,5").

   Сетка (дюймы):  M = 0,47 · правый край 12,863 · низ 7,03 · зазор 0,30
   Три цветовые зоны: A (слайды 1–3), B (слайд 4), C (слайды 5–11).
   Высоты изображений считаются из реальных пикселей (prepared/v2r/sizes.json)
   — искажение пропорций технически невозможно.
   ========================================================================== */

const pptxgen = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "presentation_v2.pptx");
const IMG = path.join(__dirname, "prepared", "v2r");
const RAW = path.join(__dirname, "prepared", "v2");
const BG = path.join(__dirname, "prepared", "backgrounds");
const SIZES = JSON.parse(fs.readFileSync(path.join(IMG, "sizes.json"), "utf8"));

const im = (n) => path.join(IMG, n);
const bg = (n) => path.join(BG, n + ".png");
const raw = (n) => path.join(RAW, n);
const aspect = (n) => {
  if (!SIZES[n]) throw new Error("нет размеров для " + n);
  return SIZES[n][0] / SIZES[n][1];
};

/* ── палитра ───────────────────────────────────────────────────────── */
const BLUE = "1B3C8C";      // зона A — королевский синий
const GARNET = "8C1D3F";    // зона A — гранатовый
const A_TINT = "F2F5FC";
const SCI = "0B69C7";       // зона B
const SCI_DK = "06407A";
const B_TINT = "EAF4FE";
const GREEN = "2E9B3E";     // зона C
const GREEN_DK = "1E7A2C";
const NAVY = "14315E";
const C_TINT = "F3FAEE";
const W = "FFFFFF";

/* ── типографика ───────────────────────────────────────────────────── */
const FH = "Montserrat ExtraBold";   // заголовки слайдов, крупные акценты
const FB = "Montserrat";             // подзаголовки и основной текст

/* ── сетка ─────────────────────────────────────────────────────────── */
const M = 0.47;
const RR = 12.863;
const BR = 7.03;
const CW = RR - M;
const RAD = 0.12;

/* ── презентация ───────────────────────────────────────────────────── */
const pres = new pptxgen();
pres.defineLayout({ name: "SCREEN16X9", width: 13.333, height: 7.5 });
pres.layout = "SCREEN16X9";
pres.author = "Еременко А.М.";
pres.company = "МБОУ СОШ №12, Вышневолоцкий муниципальный округ";
pres.title = "От «Большой Перемены» к нейролаборатории";

/* ── speaker notes: разбор полного текста доклада ──────────────────── */
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

function slide(bgName, noteIdx) {
  const s = pres.addSlide();
  s.background = { color: W };
  s.addImage({ path: bg(bgName), x: 0, y: 0, w: 13.333, h: 7.5 });
  s.addNotes(NOTES[noteIdx]);
  return s;
}

/** Заголовок слайда — единая точка привязки. */
function title(s, text, o = {}) {
  s.addText(text, {
    x: o.x ?? M, y: o.y ?? 0.22, w: o.w ?? CW, h: o.h ?? 0.72,
    fontFace: FH, fontSize: o.size ?? 36, color: o.color ?? BLUE,
    align: o.align ?? "left", valign: "top", margin: 0,
    lineSpacingMultiple: 0.95,
  });
}

/** Карточка-плашка: единый радиус, граница, мягкая тень. */
function card(s, x, y, w, h, o = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: o.radius ?? RAD,
    fill: { color: o.fill ?? W },
    line: o.line === null ? { type: "none" }
      : { color: o.line ?? BLUE, width: o.lw ?? 1.5 },
    ...(o.shadow === false ? {} : { shadow: soft(o.shadowColor, o.shadowOpacity) }),
  });
}

/** Чип-пилюля. */
function chip(s, x, y, w, h, text, o = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: h / 2,
    fill: { color: o.fill ?? BLUE },
    line: o.line ? { color: o.line, width: o.lw ?? 1.25 } : { type: "none" },
  });
  s.addText(text, {
    x: x + 0.08, y, w: w - 0.16, h,
    fontFace: o.face ?? FB, fontSize: o.size ?? 15, bold: o.bold ?? true,
    color: o.color ?? W, align: "center", valign: "middle", margin: 0,
    lineSpacingMultiple: 0.92,
  });
}

function txt(s, text, o) {
  s.addText(text, {
    fontFace: o.face ?? FB, fontSize: o.size ?? 16, bold: o.bold ?? false,
    color: o.color ?? NAVY, align: o.align ?? "left", valign: o.valign ?? "top",
    margin: 0, lineSpacingMultiple: o.ls ?? 1.0, italic: o.italic ?? false,
    x: o.x, y: o.y, w: o.w, h: o.h, charSpacing: o.cs ?? 0,
  });
}

/** Маркированный список из массива строк. */
function bullets(s, items, o) {
  const runs = items.map((t, i) => ({
    text: t,
    options: {
      bullet: { indent: o.indent ?? 12 }, breakLine: true,
      paraSpaceAfter: i === items.length - 1 ? 0 : (o.gap ?? 5),
    },
  }));
  s.addText(runs, {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fontFace: o.face ?? FB, fontSize: o.size ?? 16, bold: o.bold ?? false,
    color: o.color ?? NAVY, align: "left", valign: "top", margin: 0,
    lineSpacingMultiple: o.ls ?? 0.96,
  });
}

/** Изображение по ширине: высота — из реальных пропорций. */
function imgW(s, name, x, y, w) {
  const h = w / aspect(name);
  s.addImage({ path: im(name), x, y, w, h });
  return h;
}
/** Изображение по высоте. */
function imgH(s, name, x, y, h) {
  const w = h * aspect(name);
  s.addImage({ path: im(name), x, y, w, h });
  return w;
}

function caption(s, text, o) {
  s.addText(text, {
    x: o.x, y: o.y, w: o.w, h: o.h,
    fontFace: FB, fontSize: o.size ?? 14, bold: o.bold ?? false,
    color: o.color ?? NAVY, align: o.align ?? "left", valign: "top",
    margin: 0, lineSpacingMultiple: 0.94, italic: false,
  });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 1 — титульный (зона A)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_a_title", 0);

  // логотип «Большая Перемена» (≤ 4 см = 1,57")
  s.addImage({ path: path.join(__dirname, "prepared", "slides1-4", "s1_logo_bp.png"),
    x: M, y: 0.17, w: 1.55, h: 1.55 * 160 / 325 });

  card(s, 2.20, 0.19, 10.663, 0.68, { line: BLUE, lw: 1.25 });
  txt(s, "Муниципальное бюджетное общеобразовательное учреждение " +
         "средняя общеобразовательная школа №12", {
    x: 2.35, y: 0.24, w: 10.36, h: 0.58, size: 15, bold: true,
    color: BLUE, align: "center", valign: "middle", ls: 0.94 });

  txt(s, "От „Большой Перемены“\nк нейролаборатории", {
    x: M, y: 1.00, w: CW, h: 1.44, face: FH, size: 40, color: BLUE, ls: 0.94 });

  // левая колонка — подзаголовок и три чипа маршрута
  card(s, M, 2.56, 7.20, 2.72, { fill: GARNET, line: GARNET, shadowColor: "6E1732" });
  txt(s, "Эффективные практики в решении метапредметных задач: от теории к практике. " +
         "Как школьные инициативы трансформируются в высокотехнологичную " +
         "образовательную среду", {
    x: M + 0.24, y: 2.66, w: 6.72, h: 1.00, size: 17, bold: true, color: W, ls: 1.0 });
  const jrn = [
    "«Большая Перемена» — с марта 2020 года",
    "«Всероссийский атлас почвенных микроорганизмов»",
    "«БиоЛаб» — биосигналы и нейротехнологии",
  ];
  jrn.forEach((t, i) => chip(s, M + 0.24, 3.84 + i * 0.46, 6.72, 0.42, t,
    { fill: GARNET, line: W, lw: 1.25, size: 15 }));

  // правая колонка — фото школы и автор
  imgW(s, "s1_school.png", 7.95, 2.56, 4.913);              // 4,913 × 2,72
  card(s, 7.95, 5.40, 4.913, 0.78, { line: BLUE });
  txt(s, "Еременко А.М., учитель биологии МБОУ СОШ №12", {
    x: 8.10, y: 5.40, w: 4.61, h: 0.78, size: 17, bold: true, color: BLUE,
    align: "center", valign: "middle", ls: 0.95 });

  chip(s, 2.50, 6.28, 8.33, 0.74, "Вышневолоцкий муниципальный округ, 2026 год",
    { fill: BLUE, size: 19 });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 2 — Экосистема конкурса «Большая Перемена» (зона A)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_a_plain", 1);
  title(s, "Экосистема конкурса «Большая Перемена»", { size: 36, y: 0.18, h: 1.22 });

  const stats = [
    ["14", "уникальных «Вызовов»"],
    ["2020", "в движении с марта 2020 года"],
    ["7", "сезон конкурса идёт сейчас"],
  ];
  const sw = (CW - 2 * 0.30) / 3;
  stats.forEach(([num, lab], i) => {
    const x = M + i * (sw + 0.30);
    card(s, x, 1.22, sw, 1.10, { line: BLUE });
    txt(s, num, { x: x + 0.16, y: 1.22, w: 1.60, h: 1.10, face: FH, size: 38,
      color: GARNET, valign: "middle" });
    txt(s, lab, { x: x + 1.80, y: 1.22, w: sw - 1.96, h: 1.10, size: 16, bold: true,
      color: BLUE, valign: "middle", ls: 0.96 });
  });

  const vyz = [
    ["Сохраняй природу!", "экология, природоохранные и исследовательские проекты"],
    ["Твори!", "творческие треки, презентации и медиапроекты"],
    ["Открывай новое!", "наука, технологии и открытия вместе с наставником"],
  ];
  vyz.forEach(([name, desc], i) => {
    const y = 2.50 + i * 1.10;
    card(s, M, y, CW, 1.00, { fill: GARNET, line: GARNET, shadowColor: "6E1732" });
    s.addShape(pres.ShapeType.ellipse, { x: M + 0.24, y: y + 0.18, w: 0.60, h: 0.60,
      fill: { color: W }, line: { type: "none" } });
    txt(s, String(i + 1), { x: M + 0.24, y: y + 0.18, w: 0.60, h: 0.60, face: FH,
      size: 20, color: GARNET, align: "center", valign: "middle" });
    txt(s, "«" + name + "»", { x: M + 1.02, y: y + 0.12, w: 4.30, h: 0.72, face: FH,
      size: 26, color: W, valign: "middle" });
    txt(s, desc, { x: M + 5.45, y: y + 0.12, w: CW - 5.75, h: 0.72, size: 16,
      bold: true, color: W, valign: "middle", ls: 0.96 });
  });

  card(s, M, 5.92, CW, 1.11, { fill: BLUE, line: BLUE, shadowColor: "12285E" });
  s.addText([
    { text: "Встречи с первыми лицами государства, космонавтами, олимпийскими " +
        "чемпионами · Росатом · Роскосмос · Сбер",
      options: { breakLine: true, fontSize: 16, bold: true } },
    { text: "Технологии 4К: креативность · коммуникабельность · критическое мышление · кооперация",
      options: { fontSize: 17, fontFace: FH } },
  ], { x: M + 0.28, y: 6.02, w: CW - 0.56, h: 0.91, fontFace: FB, color: W,
    align: "left", valign: "middle", margin: 0, lineSpacingMultiple: 1.0 });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 3 — таймлайн побед (зона A)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_a_timeline", 2);
  title(s, "От кейсовых заданий «Большой Перемены» — к нейролаборатории",
    { size: 36, h: 1.30 });

  const items = [
    { img: "s3_zhilkina.png", year: "2020", name: "Ванесса Жилкина",
      main: "2020 год — Победитель", sub: "Первый победитель школы" },
    { img: "s3_grichenko.png", year: "2021", name: "Александр Гриченко",
      main: "2021, 2022 год — Победитель", sub: "Дарит школе световой микроскоп, 2022 год" },
    { img: "s3_zhukova.png", year: "2024", name: "Алёна Жукова",
      main: "2024 год — Абсолютный победитель, Лауреат I степени",
      sub: "2023, 2025 год — Призёр" },
  ];
  const cw = (CW - 2 * 0.30) / 3;
  items.forEach((it, i) => {
    const x = M + i * (cw + 0.30);
    card(s, x, 1.62, cw, 5.41, { line: BLUE });
    imgW(s, it.img, x + (cw - 2.40) / 2, 1.86, 2.40);      // 2,40 × 3,20
    txt(s, it.name, { x: x + 0.16, y: 5.14, w: cw - 0.32, h: 0.44, face: FH,
      size: 21, color: BLUE, align: "center", valign: "middle" });
    card(s, x + 0.18, 5.62, cw - 0.36, 0.82,
      { fill: GARNET, line: GARNET, shadowColor: "6E1732" });
    txt(s, it.main, { x: x + 0.28, y: 5.62, w: cw - 0.56, h: 0.82, size: 16,
      bold: true, color: W, align: "center", valign: "middle", ls: 0.94 });
    card(s, x + 0.18, 6.50, cw - 0.36, 0.53,
      { fill: A_TINT, line: BLUE, lw: 1.25, shadow: false });
    txt(s, it.sub, { x: x + 0.26, y: 6.50, w: cw - 0.52, h: 0.53, size: 14,
      bold: true, color: BLUE, align: "center", valign: "middle", ls: 0.92 });
    s.addShape(pres.ShapeType.ellipse, { x: x + 0.22, y: 1.26, w: 0.76, h: 0.76,
      fill: { color: GARNET }, line: { color: W, width: 2 } });
    txt(s, it.year, { x: x + 0.22, y: 1.26, w: 0.76, h: 0.76, face: FH, size: 15,
      color: W, align: "center", valign: "middle" });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 4 — Наука в школе: исследования учеников (зона B)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_b_micro", 3);
  title(s, "Наука в школе: исследования учеников", { size: 36, color: SCI_DK });

  // акцент-цифра
  card(s, M, 0.98, 3.05, 2.40, { fill: SCI, line: SCI, shadowColor: "05365F" });
  txt(s, "30+", { x: M + 0.18, y: 1.04, w: 2.69, h: 0.68, face: FH, size: 44,
    color: W, valign: "middle" });
  txt(s, "учеников — научные волонтёры, гражданские учёные и соавторы Атласа", {
    x: M + 0.18, y: 1.78, w: 2.69, h: 0.95, size: 16, bold: true, color: W, ls: 0.95 });
  chip(s, M + 0.18, 2.82, 1.80, 0.40, "2022–2024", { fill: W, color: SCI, size: 15 });

  card(s, 3.82, 0.98, 4.45, 2.40, { line: SCI });
  txt(s, "Партнёрство и программа", { x: 4.00, y: 1.08, w: 4.09, h: 0.36, face: FH,
    size: 19, color: SCI_DK });
  txt(s, "Осенью 2022 года — партнёрство с ФГАОУ ВО «Новосибирский национальный " +
         "исследовательский государственный университет» и вступление в программу " +
         "ИХБФМ СО РАН «Всероссийский атлас почвенных микроорганизмов»", {
    x: 4.00, y: 1.52, w: 4.09, h: 1.76, size: 16, color: SCI_DK, ls: 0.96 });

  card(s, 8.57, 0.98, 4.29, 2.40, { line: SCI });
  txt(s, "Технологическая база", { x: 8.75, y: 1.08, w: 3.93, h: 0.36, face: FH,
    size: 19, color: SCI_DK });
  txt(s, "Получены исследовательские наборы, цифровые инструменты и образовательные " +
         "ресурсы. Работа учеников переведена в плоскость доказательной науки", {
    x: 8.75, y: 1.52, w: 3.93, h: 1.36, size: 16, color: SCI_DK, ls: 0.96 });
  chip(s, 8.75, 2.86, 3.93, 0.40, "ИХБФМ СО РАН · НГУ", { fill: SCI, size: 15 });

  const photos = [
    ["s4_starter_kit.png", "Стартовый набор «Охотники за микробами» и образцы почв"],
    ["s4_diplomy_atlas.png", "Дипломы наставника Еременко А.М. и соавторов " +
      "«Всероссийского атласа почвенных микроорганизмов», 2022 год"],
    ["s4_nagrazhdenie_2024.png", "Награждение гражданских учёных, волонтёров науки, " +
      "соавторов «Всероссийского атласа почвенных микроорганизмов», 2024 год"],
    ["s4_shtammy_ihbfm.png", "Штаммы выделенных почвенных бактерий перед отправкой " +
      "в ИХБФМ СО РАН, 2023 год"],
  ];
  const pw = 2.90, pgap = (CW - 4 * pw) / 3;
  photos.forEach(([file, cap], i) => {
    const x = M + i * (pw + pgap);
    card(s, x, 3.46, pw, 3.57, { line: SCI, lw: 1.25 });
    imgW(s, file, x + 0.225, 3.54, 2.45);                  // 2,45 × 1,84
    caption(s, cap, { x: x + 0.10, y: 5.44, w: pw - 0.20, h: 1.58, size: 14,
      color: SCI_DK, bold: true, ls: 0.90 });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 5 — Наши общие победы: ключевые участники проектов (зона C)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_micro", 4);
  title(s, "Наши общие победы: ключевые участники проектов",
    { size: 36, color: NAVY, y: 0.06, h: 1.02 });

  const people = [
    {
      w: 3.50, img: "s5_zhukova.png", name: "Алёна Жукова",
      circ: "s5_circ_azoto.png", ins: "s5_ins_kult.png",
      lines: [
        "«Большая Перемена»: 2024 — Абсолютный победитель, Лауреат I степени; призёр 2023 и 2025",
        "«Большие Вызовы» 2022–2023 — победитель регионального трека; тема: скрининг азотфиксирующих бактерий, Azotobacter",
        "2× победитель НПК (Базарный Карабулак); финалист «Экопоколения»; амбассадор юннатского движения",
      ],
    },
    {
      w: 2.90, img: "s5_kolyaskina.png", name: "Ульяна Коляскина",
      circ: "s5_circ_strep.png",
      lines: [
        "Призёр регионального трека «Больших Вызовов» 2023–2024; агропромышленные и биотехнологии",
        "Тема: поиск продуцентов природных антибиотиков, штаммы Streptomyces",
        "Призёр Всероссийской метапредметной НПК (Базарный Карабулак)",
      ],
    },
    {
      w: 2.60, img: "s5_petrova.png", name: "Софья Петрова",
      lines: [
        "Финалист Всероссийского конкурса «Большая Перемена» (2022 г.)",
        "Победитель регионального трека «АгроНТИ-2022», направление «АгроРоботы»",
        "Освоила управление роботами с нуля по видеоурокам",
      ],
    },
    {
      w: 2.70, img: "s5_elizarova.png", name: "Вероника Елизарова",
      lines: [
        "Абсолютный победитель регионального этапа Всероссийского конкурса презентаций «Многоликая Россия» (2026 г.)",
        "Номинация: Дальневосточный федеральный округ",
        "Презентация «Тункинский национальный парк»",
      ],
    },
  ];

  const CY = 1.12, CH = 5.58;                  // карточки 1,12 … 6,70
  let x = M;
  people.forEach((p) => {
    card(s, x, CY, p.w, CH, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
    imgW(s, p.img, x + (p.w - 0.75) / 2, CY + 0.12, 0.75);
    if (p.circ) s.addImage({ path: im(p.circ), x: x + p.w - 0.14 - 0.70,
      y: CY + 0.14, w: 0.70, h: 0.70 });
    if (p.ins) s.addImage({ path: im(p.ins), x: x + 0.14, y: CY + 0.17,
      w: 0.64, h: 0.64 });
    card(s, x + 0.14, CY + 0.92, p.w - 0.28, 0.58,
      { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
    txt(s, p.name, { x: x + 0.18, y: CY + 0.92, w: p.w - 0.36, h: 0.58, face: FH,
      size: 19, color: W, align: "center", valign: "middle", ls: 0.90 });
    bullets(s, p.lines, { x: x + 0.16, y: CY + 1.58, w: p.w - 0.32, h: CH - 1.70,
      size: 16, color: NAVY, ls: 0.85, gap: 2, indent: 10 });
    x += p.w + 0.231;
  });

  card(s, M, 6.76, CW, 0.40, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Наставник проектных команд: учитель биологии Еременко А.М.", {
    x: M, y: 6.76, w: CW, h: 0.40, face: FH, size: 17, color: W,
    align: "center", valign: "middle" });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 6 — Наставник растёт вместе с учениками (зона C)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_cells", 5);
  title(s, "Наставник растёт вместе с учениками", { size: 36, color: NAVY });

  // веер остальных документов — лёгкая подложка наградного блока
  s.addImage({ path: raw("s6_docs_fan_20.png"), x: 0.14, y: 1.70, w: 6.20,
    h: 6.20 * 1150 / 2400 });

  // наградной коллаж: Благодарность 2024 крупно + каскад из трёх
  const colW = 5.40;
  s.addImage({ path: raw("s6_nagrady_collage.png"), x: M, y: 0.98, w: colW,
    h: colW * 1975 / 2286 });                              // 5,40 × 4,67
  card(s, M, 5.76, colW, 1.27, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Благодарность Первого заместителя Руководителя Администрации Президента " +
         "Российской Федерации С. В. Кириенко — 2020, 2021, 2022 и 2024 годы", {
    x: M + 0.20, y: 5.84, w: colW - 0.40, h: 1.11, size: 16, bold: true, color: W,
    valign: "middle", ls: 0.97 });

  // удостоверение КПК «Артек»
  const rx = 6.15;
  imgW(s, "s6_artek.png", rx, 0.98, 3.10);                 // 3,10 × 2,24
  card(s, 9.34, 0.98, 3.52, 2.24, { line: GREEN });
  txt(s, "Удостоверение о повышении квалификации ФГБОУ «Международный детский центр " +
         "„Артек“» по программе «Современные инструменты наставничества в " +
         "воспитательной деятельности образовательной организации», 36 часов", {
    x: 9.49, y: 1.06, w: 3.22, h: 2.08, size: 14, bold: true, color: NAVY, ls: 0.92 });

  // фотографии автора с новыми подписями
  const sw = 3.21;
  const ph = [
    ["s6_foto_vruchenie.png", "Вручение благодарности Первого заместителя Руководителя " +
      "Администрации Президента Российской Федерации С. В. Кириенко"],
    ["s6_foto_gruppa.png", "Групповая работа наставников победителей на образовательной " +
      "программе при решении кейсов. Почувствуй себя в роли наставляемого"],
  ];
  ph.forEach(([file, cap], i) => {
    const x = rx + i * (sw + 0.29);
    imgW(s, file, x, 3.34, sw);                            // 3,21 × 2,41
    caption(s, cap, { x, y: 5.84, w: sw, h: 1.19, size: 14, bold: true, color: NAVY });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 7 — Проект школьных инициатив (зона C)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_neuro", 6);
  title(s, "Проект школьных инициатив — от мечты к реальности!",
    { size: 36, color: NAVY, y: 0.14, h: 1.16 });

  const LW = 9.15;
  const rx = M + LW + 0.30, rw = RR - rx;                  // 3,00

  function block(x, y, w, h, head, body) {
    card(s, x, y, w, h, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
    s.addText([
      { text: head + " ", options: { bold: true, color: GREEN_DK, fontFace: FH } },
      { text: body, options: { color: NAVY } },
    ], {
      x: x + 0.18, y: y + 0.10, w: w - 0.36, h: h - 0.20,
      fontFace: FB, fontSize: 16, align: "left", valign: "top", margin: 0,
      lineSpacingMultiple: 0.94,
    });
  }

  block(M, 1.34, LW, 1.62, "Идея создания научной лаборатории.",
    "Идея создания научной лаборатории в кабинете биологии для формирования " +
    "экологически ответственного поведения и развития научной деятельности среди " +
    "школьников возникала неоднократно, когда ученики выполняли " +
    "научно-исследовательские проекты. Ребята участвовали в экологических " +
    "конкурсах для получения гранта на открытие лаборатории.");

  const hw = (LW - 0.20) / 2;
  block(M, 3.04, hw, 2.34, "Катализатор — начало открытия.",
    "Гриченко Александр, став победителем Всероссийского конкурса «Большая Перемена», " +
    "получает премию и в 2022 году передаёт в дар современный световой микроскоп — " +
    "это стало отправной точкой на пути к открытию школьной лаборатории.");
  block(M + hw + 0.20, 3.04, hw, 2.34, "Предложение проекта и первый этап.",
    "29 ноября 2024 года Жукова Алёна, Бондаренко София на школьном этапе конкурса " +
    "«Проект школьных инициатив» представили проект «Научная лаборатория БиоЛаб» и " +
    "по результатам голосования прошли на муниципальный этап конкурса.");

  block(M, 5.46, LW, 1.57, "Результат и успешная защита.",
    "На муниципальном этапе конкурса при поддержке заместителя директора по ВР " +
    "Папиной А.Н., заместителя директора по ИКТ Кулагина Артура Александровича " +
    "Жукова Алёна и Ланцев Никита успешно защищают проект, и в школе в кабинете " +
    "биологии появляется экологическое пространство с учебно-исследовательской " +
    "лабораторией биосигналов и нейротехнологий.");

  imgW(s, "s7_zashchita.png", rx + 0.17, 1.34, rw - 0.34);   // 2,60 × 1,73
  caption(s, "Жукова Алёна, Ланцев Никита успешно защищают проект «БиоЛаб» на " +
    "муниципальном этапе конкурса «Школьная инициатива»", {
    x: rx, y: 3.12, w: rw, h: 1.42, size: 14, bold: true, color: NAVY });
  imgW(s, "s7_biolab_room.png", rx + 0.17, 4.60, rw - 0.34); // 2,60 × 1,81
  caption(s, "Школьная научная лаборатория «БиоЛаб»", {
    x: rx, y: 6.48, w: rw, h: 0.46, size: 14, bold: true, color: NAVY });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 8 — «БиоЛаб» в работе: команда и исследования (зона C, БЕЗ ФОТО)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_neuro", 7);
  title(s, "«БиоЛаб» в работе: команда и исследования",
    { size: 40, color: NAVY, y: 0.16, h: 1.32 });

  card(s, M, 1.58, CW, 0.86, { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, "Наставник проекта: Еременко Анна Михайловна", {
    x: M, y: 1.58, w: CW, h: 0.86, face: FH, size: 27, color: W,
    align: "center", valign: "middle" });

  card(s, M, 2.56, CW, 2.52, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Исследователи — ученики 10 класса", {
    x: M + 0.30, y: 2.66, w: CW - 0.60, h: 0.48, face: FH, size: 25, color: W,
    valign: "middle" });
  const names = [
    ["Владимирова Диана", "Видонов Артём", "Гужов Алексей"],
    ["Елизарова Вероника", "Иванова Диана", "Малышева Анастасия"],
    ["Рощин Алексей", "Татушенко Егор", "Тропников Иван"],
  ];
  const nw = (CW - 0.60 - 2 * 0.24) / 3;
  names.forEach((row, r) => row.forEach((n, c) => {
    const x = M + 0.30 + c * (nw + 0.24);
    const y = 3.24 + r * 0.58;
    s.addShape(pres.ShapeType.roundRect, { x, y, w: nw, h: 0.50, rectRadius: 0.10,
      fill: { color: "20406F" }, line: { color: "486693", width: 1 } });
    txt(s, n, { x: x + 0.14, y, w: nw - 0.28, h: 0.50, size: 21, bold: true,
      color: W, valign: "middle" });
  }));

  card(s, M, 5.22, CW, 0.92, { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, "Ассистенты проекта (ученицы 5 «Б» класса): Виноградова Алиса, Радаева София", {
    x: M + 0.20, y: 5.22, w: CW - 0.40, h: 0.92, face: FH, size: 22, color: W,
    align: "center", valign: "middle", ls: 0.95 });

  card(s, M, 6.26, CW, 0.77, { fill: W, line: GREEN_DK, lw: 2.5 });
  txt(s, "Преемственность поколений: когда старшие ученики становятся наставниками для младших", {
    x: M + 0.20, y: 6.26, w: CW - 0.40, h: 0.77, face: FH, size: 21, color: GREEN_DK,
    align: "center", valign: "middle", ls: 0.95 });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 9 — Практическая наука в «БиоЛаб» (зона C)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_ecg", 8);
  title(s, "Практическая наука в «БиоЛаб»", { size: 38, color: NAVY });

  const w1 = 4.30, wc = 3.40, gp = (CW - 2 * w1 - wc) / 2;
  const x1 = M, xc = M + w1 + gp, x2 = xc + wc + gp;
  const CY = 1.00, CH = BR - CY;                           // 6,03

  function expCard(x, w, head, photo, body, verdict) {
    card(s, x, CY, w, CH, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
    txt(s, head, { x: x + 0.15, y: CY + 0.12, w: w - 0.30, h: 0.98, face: FH,
      size: 19, color: NAVY, ls: 0.94 });
    imgW(s, photo, x + 0.15, CY + 1.10, w - 0.30);         // 4,00 × 2,19
    txt(s, body, { x: x + 0.15, y: CY + 3.38, w: w - 0.30, h: 2.00, size: 16,
      color: NAVY, ls: 0.96 });
    chip(s, x + 0.15, CY + 5.46, w - 0.30, 0.50, verdict,
      { fill: GREEN, size: 17, face: FH });
  }

  expCard(x1, w1, "Эксперимент №1\n«От сердца к цифре»", "s9_ecg.png",
    "Цель: регистрация биосигналов и расчёт ЧСС.\n" +
    "Достижения: освоена техника I отведения и настройки фильтрации.\n" +
    "Результат: биосигналы переведены в точные цифровые данные.",
    "Вердикт: гипотеза подтверждена");

  expCard(x2, w1, "Эксперимент №2\n«Исследование адаптации сердца к нагрузкам»",
    "s9_team.png",
    "Цель: динамический цифровой мониторинг и интерпретация ЭКГ.\n" +
    "Успех: лаборатория визуализировала динамическую адаптацию организма — " +
    "физическая активность вызывает закономерное сокращение кардиоинтервала.",
    "Вердикт: гипотеза подтверждена");

  // центральный блок — формула и видео
  card(s, xc, CY, wc, CH, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Математический фундамент", { x: xc + 0.20, y: CY + 0.12, w: wc - 0.40,
    h: 0.62, face: FH, size: 19, color: W, align: "center", ls: 0.94 });
  card(s, xc + 0.20, CY + 0.86, wc - 0.40, 1.55, { fill: W, line: W, shadow: false });
  txt(s, "ЧСС = 60 / Δt", { x: xc + 0.24, y: CY + 0.96, w: wc - 0.48, h: 0.66,
    face: FH, size: 28, color: NAVY, align: "center", valign: "middle" });
  txt(s, "уд./мин, где Δt — интервал R–R в секундах", { x: xc + 0.34, y: CY + 1.66,
    w: wc - 0.68, h: 0.68, size: 14, bold: true, color: GREEN_DK, align: "center",
    ls: 0.94 });

  const vy = CY + 2.55, vh = 2.60;
  card(s, xc + 0.20, vy, wc - 0.40, vh, { fill: "1D4478", line: W, lw: 2, shadow: false });
  const cd = 1.10, ccx = xc + wc / 2 - cd / 2, ccy = vy + 0.55;
  s.addShape(pres.ShapeType.ellipse, { x: ccx, y: ccy, w: cd, h: cd,
    fill: { color: GREEN }, line: { color: W, width: 2.5 } });
  s.addShape(pres.ShapeType.triangle, { x: ccx + 0.36, y: ccy + 0.28, w: 0.42, h: 0.54,
    fill: { color: W }, line: { type: "none" }, rotate: 90 });
  txt(s, "Видеофрагмент: ребята показывают ход эксперимента и расчёты", {
    x: xc + 0.34, y: vy + 1.80, w: wc - 0.68, h: 0.70, size: 14, bold: true,
    color: W, align: "center", ls: 0.94 });

  chip(s, xc + 0.20, CY + 5.46, wc - 0.40, 0.50, "Цифровая лаборатория «Радуга»",
    { fill: GREEN, size: 15 });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 10 — Перспективные направления (зона C)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_split", 9);
  title(s, "Перспективные направления", { size: 38, color: NAVY });

  txt(s, "В наступающем учебном году в нашей школьной лаборатории мы планируем " +
         "развивать два перспективных научно-исследовательских вектора", {
    x: M, y: 0.96, w: CW, h: 0.72, size: 18, bold: true, color: GREEN_DK, ls: 0.96 });

  const cw2 = (CW - 0.30) / 2, CY = 1.66, CH = BR - CY;    // 5,37
  // ── левый: классическая биология
  card(s, M, CY, cw2, CH, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
  card(s, M + 0.16, CY + 0.14, cw2 - 0.32, 0.66,
    { fill: GREEN, line: GREEN, shadow: false });
  txt(s, "Вектор классической биологии (5–7 классы)", {
    x: M + 0.26, y: CY + 0.14, w: cw2 - 0.52, h: 0.66, face: FH, size: 21, color: W,
    align: "center", valign: "middle", ls: 0.94 });
  s.addText([
    { text: "Тема: ", options: { bold: true, color: GREEN_DK, fontFace: FH } },
    { text: "«Экспериментальное исследование факторов успешной вегетативной " +
        "репродукции лимонов сортов „Лунарио“ и „Павловский“ с изучением их " +
        "морфометрических признаков»", options: { color: NAVY } },
  ], { x: M + 0.20, y: CY + 0.86, w: cw2 - 0.40, h: 0.95, fontFace: FB, fontSize: 16,
    margin: 0, valign: "top", lineSpacingMultiple: 0.96 });
  s.addText([
    { text: "Направленность: ", options: { bold: true, color: GREEN_DK, fontFace: FH } },
    { text: "«Сравнительный морфологический анализ, оценка регенерационного " +
        "потенциала тканей и выявление оптимальных условий экзогенной регуляции " +
        "ризогенеза»", options: { color: NAVY } },
  ], { x: M + 0.20, y: CY + 1.86, w: cw2 - 0.40, h: 1.28, fontFace: FB, fontSize: 16,
    margin: 0, valign: "top", lineSpacingMultiple: 0.96 });

  const lx = M + 0.26, ly = CY + 3.22;                     // фото 1,50 × 2,00
  card(s, lx - 0.07, ly - 0.07, 1.64, 2.14, { fill: NAVY, line: NAVY, shadow: false });
  imgW(s, "s10_limony.png", lx, ly, 1.50);
  caption(s, "Маточные кустики сортовых лимонов «Лунарио» и «Павловский» " +
    "(для экспериментов)", { x: lx + 1.74, y: ly + 0.04, w: cw2 - 2.20, h: 1.10,
    size: 14, bold: true, color: NAVY });
  chip(s, lx + 1.74, ly + 1.24, 2.40, 0.48, "5–7 классы", { fill: GREEN, size: 15 });

  // ── правый: Data Science и биомедицина
  const x2 = M + cw2 + 0.30;
  card(s, x2, CY, cw2, CH, { line: NAVY, lw: 1.5, shadowColor: "8AA98C" });
  card(s, x2 + 0.16, CY + 0.14, cw2 - 0.32, 0.66,
    { fill: NAVY, line: NAVY, shadow: false });
  txt(s, "Вектор Data Science и биомедицины (9–11 классы)", {
    x: x2 + 0.26, y: CY + 0.14, w: cw2 - 0.52, h: 0.66, face: FH, size: 21, color: W,
    align: "center", valign: "middle", ls: 0.94 });
  s.addText([
    { text: "Тема: ", options: { bold: true, color: NAVY, fontFace: FH } },
    { text: "«От цифры к микромиру: нейросенсорное восприятие биологических данных " +
        "и статистический анализ (t-критерий Стьюдента / U-критерий Манна — Уитни) " +
        "в школьной лаборатории „БиоЛаб“»", options: { color: NAVY } },
  ], { x: x2 + 0.20, y: CY + 0.92, w: cw2 - 0.40, h: 1.30, fontFace: FB, fontSize: 16,
    margin: 0, valign: "top", lineSpacingMultiple: 0.96 });
  s.addText([
    { text: "Направленность: ", options: { bold: true, color: NAVY, fontFace: FH } },
    { text: "интеграция цифровой лаборатории «Радуга», проектов гражданской науки " +
        "и методов математической статистики", options: { color: NAVY } },
  ], { x: x2 + 0.20, y: CY + 2.30, w: cw2 - 0.40, h: 0.94, fontFace: FB, fontSize: 16,
    margin: 0, valign: "top", lineSpacingMultiple: 0.96 });

  const chips = [
    "t-критерий Стьюдента", "U-критерий Манна — Уитни",
    "Цифровая лаборатория «Радуга»", "Проекты гражданской науки",
  ];
  const chw = (cw2 - 0.40 - 0.20) / 2;
  chips.forEach((t, i) => {
    chip(s, x2 + 0.20 + (i % 2) * (chw + 0.20), CY + 3.32 + Math.floor(i / 2) * 0.66,
      chw, 0.58, t, { fill: i % 2 ? GREEN : NAVY, size: 15 });
  });
  card(s, x2 + 0.20, CY + 4.62, cw2 - 0.40, 0.68, { fill: C_TINT, line: GREEN, lw: 1.5,
    shadow: false });
  txt(s, "Доказательный анализ результатов прямо в школьной лаборатории", {
    x: x2 + 0.30, y: CY + 4.62, w: cw2 - 0.60, h: 0.68, face: FH, size: 17,
    color: GREEN_DK, align: "center", valign: "middle", ls: 0.94 });
}

/* ══════════════════════════════════════════════════════════════════════
   СЛАЙД 11 — Общие выводы (зона C, финал)
   ══════════════════════════════════════════════════════════════════════ */
{
  const s = slide("bg_c_final", 10);
  s.addImage({ path: raw("s11_docs_fan_15.png"), x: 1.55, y: 1.30, w: 10.20,
    h: 10.20 * 1150 / 2400 });
  title(s, "Общие выводы", { size: 38, color: NAVY });

  const outs = [
    ["1", "Эффективность проектных лифтов",
      "успешное участие в конкурсах уровня «Большой Перемены» служит мощным " +
      "стартовым фундаментом для создания инновационной инфраструктуры внутри " +
      "обычной школы"],
    ["2", "Переход к доказательной науке",
      "использование цифровых лабораторий переводит уроки биологии в плоскость " +
      "доказательной науки, наглядно визуализируя скрытые физиологические процессы"],
    ["3", "Метапредметный результат",
      "работа с нейролабораторией эффективно формирует у школьников устойчивые " +
      "hard и soft skills, стирая границы между школьным экспериментом и будущей " +
      "профессией"],
  ];
  const ow = (CW - 2 * 0.30) / 3;
  outs.forEach(([n, head, body], i) => {
    const x = M + i * (ow + 0.30);
    card(s, x, 1.00, ow, 2.86, { line: GREEN, lw: 1.5, shadowColor: "8AA98C" });
    s.addShape(pres.ShapeType.ellipse, { x: x + 0.18, y: 1.14, w: 0.54, h: 0.54,
      fill: { color: GREEN }, line: { type: "none" } });
    txt(s, n, { x: x + 0.18, y: 1.14, w: 0.54, h: 0.54, face: FH, size: 18, color: W,
      align: "center", valign: "middle" });
    txt(s, head, { x: x + 0.84, y: 1.12, w: ow - 1.02, h: 0.70, face: FH, size: 18,
      color: GREEN_DK, valign: "middle", ls: 0.94 });
    txt(s, body, { x: x + 0.20, y: 1.94, w: ow - 0.40, h: 1.80, size: 16, color: NAVY,
      ls: 0.96 });
  });

  card(s, M, 4.00, 5.00, 1.92, { fill: GREEN, line: GREEN, shadowColor: "8AA98C" });
  txt(s, "Победа в конкурсе — это не финал, а стартовая точка к новым возможностям!", {
    x: M + 0.24, y: 4.00, w: 4.52, h: 1.92, face: FH, size: 24, color: W,
    align: "center", valign: "middle", ls: 0.98 });

  card(s, M + 5.30, 4.00, CW - 5.30, 1.92, { fill: NAVY, line: NAVY, shadowColor: "0C1E3A" });
  txt(s, "Прежде чем сказать вам «Спасибо за внимание!», хочется сказать спасибо " +
         "администрации школы, коллегам, родителям, ученикам, всем, кто был рядом. " +
         "Кто вместе с нами радовался нашим достижениям и разделял «горечь поражения». " +
         "Кто поддерживал, советовал и помогал.", {
    x: M + 5.54, y: 4.00, w: CW - 5.78, h: 1.92, size: 17, bold: true, color: W,
    valign: "middle", ls: 1.0 });

  txt(s, "Спасибо за внимание!", { x: M, y: 6.08, w: CW, h: 0.95, face: FH, size: 44,
    color: NAVY, align: "center", valign: "middle" });
}

/* ── запись ────────────────────────────────────────────────────────── */
pres.writeFile({ fileName: OUT }).then(() => {
  console.log("готово:", OUT);
  console.log("слайдов:", 11, "· заметок:", NOTES.length);
});
