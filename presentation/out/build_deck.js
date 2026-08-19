/* Сборка presentation.pptx — «От „Большой Перемены“ к нейролаборатории»
   Формат 16:9 (13,333 × 7,5 дюйма = 33,87 × 19,05 см), поля 1,2 см = 0,47".
   Палитра и типографика — из out/slide_plan.md.

   Единая сетка (все значения в дюймах):
     M   = 0.47      левое поле (1,2 см)
     RR  = 12.863    правая направляющая (13,333 − 1,2 см)
     BR  = 7.03      нижняя направляющая (7,5 − 1,2 см)
     TY  = 0.32      верх заголовка на КАЖДОМ слайде
     CT1 = 1.15      верх контента при однострочном заголовке
     CT2 = 1.60      верх контента при двухстрочном заголовке (слайды 3 и 9)
     GAP = 0.30      единый зазор между карточками/фото
   Высота всех изображений вычисляется из их реальных пикселей (prepared/build/
   sizes.json) — искажение пропорций технически невозможно.                    */

const pptxgen = require("pptxgenjs");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "presentation.pptx");
const IMG = path.join(__dirname, "prepared", "build");
const SIZES = JSON.parse(fs.readFileSync(path.join(IMG, "sizes.json"), "utf8"));
const im = (n) => path.join(IMG, n);
const aspect = (n) => {
  if (!SIZES[n]) throw new Error("нет размеров для " + n + " — запустите prep_images.py");
  return SIZES[n][0] / SIZES[n][1];
};

/* ── дизайн-система ─────────────────────────────────────────────── */
const NAVY = "2B549E";
const CRIM = "E11E4F";
const SKY = "25ADE4";
const TINT = "F4F6FB";
const INK = "1B2A4A";
const MUTED = "5A6785";
const LINE = "DDE3EF";
const W = "FFFFFF";
const F = "Montserrat";

const M = 0.47;                 // поле, дюймы
const RR = 12.863;              // правая направляющая
const BR = 7.03;                // нижняя направляющая
const CW = RR - M;              // ширина контента
const GAP = 0.30;               // единый зазор
const TY = 0.32;                // верх заголовка
const CT1 = 1.15;               // верх контента (однострочный заголовок)
const CT2 = 1.60;               // верх контента (двухстрочный заголовок)
const R = 0.11;                 // единое скругление карточек
const CAP = 12;                 // единый кегль подписей к фото

const shadow = () => ({ type: "outer", color: "9AA7C0", blur: 10, offset: 2, angle: 90, opacity: 0.22 });

const pres = new pptxgen();
pres.defineLayout({ name: "SCREEN16X9", width: 13.333, height: 7.5 });
pres.layout = "SCREEN16X9";
pres.author = "Еременко А.М.";
pres.title = "От «Большой Перемены» к нейролаборатории";

/* ── помощники ──────────────────────────────────────────────────── */
function newSlide() {
  const s = pres.addSlide();
  s.background = { color: W };
  return s;
}

/** Заголовок слайда: единая точка привязки (верх) и единый кегль. */
function title(s, text, opts = {}) {
  s.addText(text, {
    x: M, y: TY, w: CW, h: 1.15,
    fontFace: F, fontSize: opts.size ?? 30, bold: true, color: NAVY,
    align: "left", valign: "top", margin: 0, lineSpacingMultiple: 1.05,
  });
}

function card(s, x, y, w, h, opts = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: R,
    fill: { color: opts.fill ?? TINT },
    line: opts.border ? { color: opts.border, width: opts.borderWidth ?? 1 } : { type: "none" },
    ...(opts.shadow ? { shadow: shadow() } : {}),
  });
}

function chipPill(s, x, y, w, h, text, bg, fg = W, size = 12, opts = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: h / 2,
    fill: { color: bg },
    line: opts.border ? { color: opts.border, width: 1 } : { type: "none" },
  });
  s.addText(text, {
    x, y, w, h, fontFace: F, fontSize: size, bold: opts.bold ?? true, color: fg,
    align: "center", valign: "middle", margin: 0,
  });
}

function circleNum(s, x, y, d, text, fill, size = 15) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: fill }, line: { type: "none" } });
  s.addText(text, {
    x, y, w: d, h: d, fontFace: F, fontSize: size, bold: true, color: W,
    align: "center", valign: "middle", margin: 0,
  });
}

/** Подпись под изображением — единый кегль/цвет на всей презентации. */
function caption(s, x, y, w, text, opts = {}) {
  s.addText(text, {
    x, y, w, h: opts.h ?? 0.32, fontFace: F, fontSize: opts.size ?? CAP,
    color: opts.color ?? MUTED, align: opts.align ?? "left", valign: "top",
    margin: 0, lineSpacingMultiple: 1.06, italic: opts.italic ?? false,
  });
}

/** Изображение по ширине: высота считается из реальных пропорций файла. */
function imgW(s, name, x, y, w) {
  const h = w / aspect(name);
  s.addImage({ path: im(name), x, y, w, h });
  return h;
}

/** Изображение по высоте: ширина считается из реальных пропорций файла. */
function imgH(s, name, x, y, h) {
  const w = h * aspect(name);
  s.addImage({ path: im(name), x, y, w, h });
  return w;
}

/* ═══════════════ СЛАЙД 1. Титульный ═══════════════ */
{
  const s = newSlide();

  s.addText(
    "Муниципальное бюджетное общеобразовательное учреждение средняя общеобразовательная школа №12",
    { x: M, y: TY, w: 10.55, h: 0.40, fontFace: F, fontSize: 12.5, color: NAVY, margin: 0, valign: "top" }
  );
  imgW(s, "logo_bp.png", 11.24, 0.26, 1.623);

  s.addText(
    [
      { text: "От «Большой Перемены»", options: { color: NAVY, breakLine: true } },
      { text: "к ", options: { color: NAVY } },
      { text: "нейролаборатории", options: { color: CRIM } },
    ],
    { x: M, y: 1.28, w: 12.0, h: 1.92, fontFace: F, fontSize: 40, bold: true, margin: 0, lineSpacingMultiple: 1.12 }
  );

  s.addText(
    "Эффективные практики в решении метапредметных задач: от теории к практике. " +
    "Как школьные инициативы трансформируются в высокотехнологичную образовательную среду",
    { x: M, y: 3.32, w: 6.85, h: 1.6, fontFace: F, fontSize: 14, color: MUTED, margin: 0, lineSpacingMultiple: 1.25 }
  );

  // декор-«точки» айдентики
  s.addShape(pres.ShapeType.ellipse, { x: M + 0.13, y: 5.71, w: 0.30, h: 0.30, fill: { color: CRIM }, line: { type: "none" } });
  s.addShape(pres.ShapeType.ellipse, { x: M + 0.59, y: 5.83, w: 0.18, h: 0.18, fill: { color: SKY }, line: { type: "none" } });
  s.addShape(pres.ShapeType.ellipse, { x: M + 0.93, y: 5.90, w: 0.11, h: 0.11, fill: { color: NAVY }, line: { type: "none" } });

  const photoW = 5.12;
  imgW(s, "s1_school.jpg", RR - photoW, 3.18, photoW);

  s.addText("Еременко А.М., учитель биологии МБОУ СОШ №12",
    { x: 6.40, y: 6.22, w: RR - 6.40, h: 0.36, fontFace: F, fontSize: 15, bold: true, color: NAVY, align: "right", margin: 0 });
  s.addText("Вышневолоцкий муниципальный округ, 2026 год",
    { x: M, y: 6.68, w: CW, h: 0.35, fontFace: F, fontSize: 12, color: MUTED, align: "center", margin: 0 });

  s.addNotes(
    "Добрый день! Меня зовут Еременко Анна Михайловна, я учитель биологии школы №12 Вышневолоцкого муниципального округа. " +
    "Сегодня я расскажу историю о том, как обычный школьный кабинет биологии за несколько лет вырос в цифровую нейролабораторию. " +
    "Отправной точкой этого пути стал всероссийский конкурс «Большая Перемена». " +
    "Это не рассказ про один удачный проект, а про выстроенную систему: конкурс — исследования — грант — собственная лаборатория. " +
    "И главное — про преемственность: сегодня рядом с одиннадцатиклассниками в лаборатории работают пятиклассники. (~35 сек)"
  );
}

/* ═══════════════ СЛАЙД 2. Экосистема конкурса ═══════════════ */
{
  const s = newSlide();
  title(s, "Экосистема конкурса «Большая Перемена»");

  const rowBot = 4.45;                       // низ верхнего ряда
  const leftW = 3.35;
  const rightX = M + leftW + GAP;            // 4.12
  const rightW = RR - rightX;                // 8.743

  card(s, M, CT1, leftW, rowBot - CT1, { fill: TINT });
  s.addText("7", { x: M, y: 1.57, w: leftW, h: 1.35, fontFace: F, fontSize: 86, bold: true, color: CRIM, align: "center", valign: "middle", margin: 0 });
  s.addText("сезон", { x: M, y: 2.97, w: leftW, h: 0.42, fontFace: F, fontSize: 21, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });
  s.addText("участвуем с марта 2020 года", { x: M + 0.2, y: 3.49, w: leftW - 0.4, h: 0.55, fontFace: F, fontSize: 13, color: MUTED, align: "center", valign: "top", margin: 0, lineSpacingMultiple: 1.1 });

  // заголовок и перечисление — один блок с центровкой: карточка не «проваливается»
  card(s, rightX, CT1, rightW, 1.80, { fill: NAVY });
  s.addText(
    [
      { text: "Для всех категорий", options: { fontSize: 18, bold: true, color: W, breakLine: true, paraSpaceAfter: 6 } },
      { text: "ученики 1–4 и 5–7 классов, старшеклассники и студенты СПО, иностранные граждане, образовательные организации", options: { fontSize: 16, color: "E4EAF6" } },
    ],
    { x: rightX + 0.28, y: CT1, w: rightW - 0.56, h: 1.80, fontFace: F, valign: "middle", margin: 0, lineSpacingMultiple: 1.14 }
  );

  card(s, rightX, 3.15, rightW, 1.30, { fill: SKY });
  s.addText(
    [
      { text: "Новые группы участников", options: { fontSize: 18, bold: true, color: W, breakLine: true, paraSpaceAfter: 6 } },
      { text: "детские команды, дети с ограниченными возможностями здоровья", options: { fontSize: 16, color: "EAF7FD" } },
    ],
    { x: rightX + 0.28, y: 3.15, w: rightW - 0.56, h: 1.30, fontFace: F, valign: "middle", margin: 0, lineSpacingMultiple: 1.14 }
  );

  card(s, M, 4.75, CW, BR - 4.75, { fill: TINT });
  s.addText("Интересно каждому: 14 направлений",
    { x: M + 0.38, y: 5.13, w: CW - 0.76, h: 0.48, fontFace: F, fontSize: 22, bold: true, color: NAVY, margin: 0, valign: "middle" });
  const chipX = M + 0.38;
  const chipW = (CW - 0.76 - 3 * GAP) / 4;
  const chips = [["Твори!", CRIM], ["Открывай новое!", SKY], ["Сохраняй природу!", NAVY]];
  chips.forEach(([t, c], i) => chipPill(s, chipX + i * (chipW + GAP), 5.85, chipW, 0.80, t, c, W, 17));
  chipPill(s, chipX + 3 * (chipW + GAP), 5.85, chipW, 0.80, "…и ещё 11 направлений", W, MUTED, 14, { border: LINE, bold: false });

  s.addNotes(
    "Несколько слов о самом конкурсе, чтобы был понятен масштаб. «Большая Перемена» — это не олимпиада для отличников, " +
    "а конкурс, где ценят не оценки, а умение решать реальные задачи. Сейчас идёт уже седьмой сезон, и охват участников " +
    "постоянно расширяется: младшие школьники с первого класса, старшеклассники, студенты колледжей, образовательные " +
    "организации, детские команды, ребята с ограниченными возможностями здоровья. Четырнадцать направлений позволяют " +
    "каждому найти своё: от «Сохраняй природу» до «Предпринимай». Наша школа участвует в конкурсе с самого первого сезона, " +
    "с марта 2020 года. (~35 сек)"
  );
}

/* ═══════════════ СЛАЙД 3. От кейсов — к победам ═══════════════ */
{
  const s = newSlide();
  // неразрывный пробел не даёт предлогу «к» повиснуть в конце строки
  title(s, "От кейсовых заданий «Большой Перемены» — к нейролаборатории");

  const plateW = (CW - GAP) / 2;             // 6.0465
  const plateH = 0.96;

  card(s, M, CT2, plateW, plateH, { fill: NAVY });
  s.addText(
    [
      { text: "7", options: { fontSize: 40, bold: true, color: W } },
      { text: "  сезонов с марта 2020 года", options: { fontSize: 17, bold: true, color: W } },
    ],
    { x: M, y: CT2, w: plateW, h: plateH, fontFace: F, align: "center", valign: "middle", margin: 0 }
  );

  card(s, M + plateW + GAP, CT2, plateW, plateH, { fill: CRIM });
  s.addText(
    [
      { text: "4", options: { fontSize: 40, bold: true, color: W } },
      { text: "  победы", options: { fontSize: 17, bold: true, color: W } },
      { text: "   ·   ", options: { fontSize: 17, color: "F7C3D2" } },
      { text: "2", options: { fontSize: 40, bold: true, color: W } },
      { text: "  призёрства", options: { fontSize: 17, bold: true, color: W } },
    ],
    { x: M + plateW + GAP, y: CT2, w: plateW, h: plateH, fontFace: F, align: "center", valign: "middle", margin: 0 }
  );

  const people = [
    { img: "s3_zhilkina.jpg", chip: "ПОБЕДИТЕЛЬ", color: SKY, name: "Жилкина Ванесса", detail: "победитель «Большой Перемены»" },
    { img: "s3_grichenko.jpg", chip: "ДВУКРАТНЫЙ ПОБЕДИТЕЛЬ", color: NAVY, name: "Гриченко Александр", detail: "две победы «Большой Перемены»" },
    { img: "s3_zhukova.jpg", chip: "АБСОЛЮТНЫЙ ПОБЕДИТЕЛЬ", color: CRIM, name: "Жукова Алёна", detail: "лауреат I степени,\nдвукратный призёр" },
  ];
  const cardW = (CW - 2 * GAP) / 3;          // 3.931
  const cardY = 2.80;
  people.forEach((p, i) => {
    const x = M + i * (cardW + GAP);
    card(s, x, cardY, cardW, BR - cardY, { fill: W, border: LINE, shadow: true });
    const pw = 1.88;
    imgW(s, p.img, x + (cardW - pw) / 2, 3.00, pw);
    chipPill(s, x + 0.30, 5.63, cardW - 0.60, 0.34, p.chip, p.color, W, 11);
    s.addText(p.name, { x: x + 0.15, y: 6.01, w: cardW - 0.30, h: 0.42, fontFace: F, fontSize: 19, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });
    s.addText(p.detail, { x: x + 0.15, y: 6.45, w: cardW - 0.30, h: 0.48, fontFace: F, fontSize: 14, color: MUTED, align: "center", valign: "top", margin: 0, lineSpacingMultiple: 1.08 });
  });

  s.addNotes(
    "С первого сезона, с марта 2020 года, наша школа участвует в каждом сезоне «Большой Перемены» — всего в семи. " +
    "За это время ребята принесли школе четыре победы и два призёрства. Победителями стали трое: Ванесса Жилкина, " +
    "Александр Гриченко — двукратный победитель, и Алёна Жукова — абсолютный победитель и лауреат первой степени, " +
    "а также дважды призёр, лауреат второй степени. Обратите внимание: это не разовый успех, а результат, который " +
    "повторяется из сезона в сезон. Именно призовой фонд и опыт этих ребят стали трамплином к следующему шагу — " +
    "собственной цифровой нейролаборатории. (~40 сек)\n\n" +
    "Атрибуция фотографий подтверждена автором 20 августа 2026 года."
  );
}

/* ═══════════════ СЛАЙД 4. Наука в школе ═══════════════ */
{
  const s = newSlide();
  title(s, "Наука в школе: исследования учеников");

  const colGap = 0.50;
  const colW = (CW - colGap) / 2;            // 5.9465
  const rightX = M + colW + colGap;

  s.addShape(pres.ShapeType.line, { x: M + colW + colGap / 2, y: CT1, w: 0, h: 6.36 - CT1, line: { color: SKY, width: 1 } });

  const cols = [
    {
      x: M, accent: NAVY, name: "Коляскина Ульяна",
      main: "s4_kol_main.jpg", mainCap: "Подготовка питательных сред",
      circ: "s4_micro_strep.jpg", circCap: "Микроскопия Streptomyces",
      text: "Искала продуцентов природных антибиотиков в разных типах экосистем.",
      award: "Призёр «Больших Вызовов» и НПК «Движение вперёд», 2024 год",
    },
    {
      x: rightX, accent: CRIM, name: "Жукова Алёна",
      main: "s4_zhu_main.jpg", mainCap: "Работа с микропрепаратами",
      circ: "s4_micro_azoto.jpg", circCap: "Микроскопия Azotobacter",
      text: "Изучала азотфиксирующие бактерии — стимуляторы роста растений.",
      award: "Победитель «Больших Вызовов» и НПК «Движение вперёд», 2023–2025 годы",
    },
  ];

  cols.forEach((c) => {
    card(s, c.x, CT1, colW, 0.56, { fill: c.accent });
    s.addText(c.name, { x: c.x + 0.26, y: CT1, w: colW - 0.52, h: 0.56, fontFace: F, fontSize: 20, bold: true, color: W, valign: "middle", margin: 0 });

    const mainW = 3.35;
    const mainH = imgW(s, c.main, c.x, 1.91, mainW);      // 2.5125
    const circD = 2.20;
    imgW(s, c.circ, c.x + colW - circD, 1.91 + (mainH - circD) / 2, circD);

    caption(s, c.x, 4.52, mainW, c.mainCap, { size: CAP });
    caption(s, c.x + colW - circD - 0.25, 4.52, circD + 0.25, c.circCap, { size: CAP, align: "center" });

    s.addText(c.text, { x: c.x, y: 4.98, w: colW, h: 0.76, fontFace: F, fontSize: 18, color: INK, valign: "top", margin: 0, lineSpacingMultiple: 1.14 });
    s.addText(c.award, { x: c.x, y: 5.80, w: colW, h: 0.56, fontFace: F, fontSize: 15, bold: true, color: c.accent, valign: "top", margin: 0, lineSpacingMultiple: 1.12 });
  });

  card(s, M, BR - 0.56, CW, 0.56, { fill: TINT });
  s.addText("Администрация школы оказывала активное содействие",
    { x: M, y: BR - 0.56, w: CW, h: 0.56, fontFace: F, fontSize: 18, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });

  s.addNotes(
    "Конкурс дал ребятам не только дипломы, но и вкус к настоящей исследовательской работе. Ульяна Коляскина искала " +
    "продуценты природных антибиотиков в разных типах экосистем — от смешанного леса до прибрежной зоны: отбирала пробы " +
    "почвы, определяла pH вытяжки, выделяла штаммы и проверяла их антибактериальную активность. Алёна Жукова провела " +
    "скрининг азотфиксирующих бактерий на способность стимулировать рост растений. Обе работы получили признание за " +
    "пределами округа: региональный трек «Больших Вызовов» и конференция «Движение вперёд». Отдельно подчеркну: всё это " +
    "стало возможно потому, что администрация школы активно содействовала — выделяла помещение, время и поддерживала " +
    "выезды. (~40 сек)\n\n" +
    "Подписи к фотографиям нейтральные: личности на кадрах отдельно не подтверждались."
  );
}

/* ═══════════════ СЛАЙД 5. Наставник ═══════════════ */
{
  const s = newSlide();
  title(s, "Наставник растёт вместе с учениками");

  const photoW = 2.60;                       // все три кадра 4:3 — одна ширина
  const photoH = photoW / aspect("s5_photo1.jpg");
  const photos = [
    { f: "s5_photo1.jpg", cap: "Еременко А.М., программа наставников «Большой Перемены»" },
    { f: "s5_photo2.jpg", cap: "Групповая работа наставников, «Мрия»" },
    { f: "s5_photo3.jpg", cap: "Сообщество наставников #БольшаяПеремена" },
  ];
  const capY = CT1 + photoH + 0.10;
  photos.forEach((p, i) => {
    const x = M + i * (photoW + GAP);
    imgW(s, p.f, x, CT1, photoW);
    caption(s, x, capY, photoW + 0.20, p.cap, { size: CAP, h: 0.62 });
  });

  // грамоты — та же высота, что у фото: один горизонт по всему ряду
  const gramX0 = M + 3 * (photoW + GAP);     // 9.17
  const gramZone = RR - gramX0;              // 3.693
  const g1w = photoH * aspect("s5_gram2021.jpg");
  const g2w = photoH * aspect("s5_gram2024.jpg");
  const gx = gramX0 + (gramZone - (g1w + g2w + GAP)) / 2;
  imgH(s, "s5_gram2021.jpg", gx, CT1, photoH);
  imgH(s, "s5_gram2024.jpg", gx + g1w + GAP, CT1, photoH);
  caption(s, gramX0, capY, gramZone, "Благодарности С.В. Кириенко,\n2021 и 2024 годы", { size: CAP, align: "center", h: 0.62 });

  const nums = [
    ["4", CRIM, "федеральные благодарности С.В. Кириенко"],
    ["5+", NAVY, "программ повышения квалификации, «Мрия» и «Артек»"],
    ["3", SKY, "всероссийские конференции, где работала в жюри"],
    ["2", CRIM, "диплома наставника «Атласа почвенных микроорганизмов»"],
  ];
  const numW = (CW - 3 * GAP) / 4;           // 2.873
  const numY = 4.10;
  nums.forEach(([n, c, t], i) => {
    const x = M + i * (numW + GAP);
    card(s, x, numY, numW, 1.95, { fill: TINT });
    s.addText(n, { x: x + 0.22, y: numY + 0.12, w: numW - 0.44, h: 0.60, fontFace: F, fontSize: 36, bold: true, color: c, margin: 0, valign: "middle" });
    s.addText(t, { x: x + 0.22, y: numY + 0.80, w: numW - 0.44, h: 1.00, fontFace: F, fontSize: 15, color: INK, valign: "top", margin: 0, lineSpacingMultiple: 1.12 });
  });

  card(s, M, BR - 0.56, CW, 0.56, { fill: TINT });
  s.addText("Почётная грамота Министерства образования Тверской области, 2022 год",
    { x: M, y: BR - 0.56, w: CW, h: 0.56, fontFace: F, fontSize: 17, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });

  s.addNotes(
    "Конкурс изменил не только детей — он изменил меня. С 2020 по 2024 год я получила четыре благодарности первого " +
    "заместителя Руководителя Администрации Президента Российской Федерации Сергея Владиленовича Кириенко — за " +
    "наставничество победителей «Большой Перемены». Вместе с победами пришло обучение: образовательные программы для " +
    "наставников в «Мрии» и в «Артеке», курсы повышения квалификации — больше пяти программ. Сегодня я сама работаю в " +
    "жюри всероссийских метапредметных конференций и веду проектные команды «Всероссийского атласа почвенных " +
    "микроорганизмов». Наставник, который перестал учиться, перестаёт быть наставником — и это, пожалуй, главное, " +
    "что дал мне конкурс. (~35 сек)"
  );
}

/* ═══════════════ СЛАЙД 6. Ученики: пять компетенций ═══════════════ */
{
  const s = newSlide();
  title(s, "Что конкурс дал ученикам: пять компетенций");

  const leftW = 8.35;
  const rightX = M + leftW + GAP;            // 9.12
  const rightW = RR - rightX;                // 3.743

  const comp = [
    [NAVY, "Исследовательские навыки", " — гипотеза и эксперимент"],
    [SKY, "Работа с данными", " — датчики, ЭКГ, кардиограммы"],
    [CRIM, "Публичная защита", " — проект перед комиссией"],
    [NAVY, "Командная работа", " — диплом I степени у каждого"],
    [CRIM, "Преемственность", " — 5 «Б» рядом с 10 классом"],
  ];
  comp.forEach(([c, a, b], i) => {
    const y = CT1 + i * 0.64;
    card(s, M, y, leftW, 0.56, { fill: TINT });
    circleNum(s, M + 0.18, y + 0.08, 0.40, String(i + 1), c, 14);
    s.addText(
      [{ text: a, options: { bold: true, color: INK } }, { text: b, options: { color: MUTED } }],
      { x: M + 0.72, y, w: leftW - 0.90, h: 0.56, fontFace: F, fontSize: 18, valign: "middle", margin: 0 }
    );
  });

  const dipY = 4.51;
  const dipH = 1.80;
  let dx = M;
  ["s6_dip1.jpg", "s6_dip2.jpg", "s6_dip3.jpg", "s6_dip4.jpg"].forEach((f) => {
    dx += imgH(s, f, dx, dipY, dipH) + GAP;
  });

  s.addText(
    [
      { text: "«Большие Вызовы» — Жукова Алёна и Коляскина Ульяна · «Экопоколение» — Жукова Алёна · «Многоликая Россия» — Елизарова Вероника", options: { color: INK, breakLine: true } },
      { text: "…и другие дипломы конкурсов и научно-практических конференций", options: { color: MUTED, italic: true } },
    ],
    { x: M, y: 6.36, w: leftW, h: 0.62, fontFace: F, fontSize: CAP, margin: 0, valign: "top", lineSpacingMultiple: 1.10 });

  const liveH = imgW(s, "s6_live.jpg", rightX, CT1, rightW);
  caption(s, rightX, CT1 + liveH + 0.07, rightW,
    "Награждение победителя конкурса «Многоликая Россия», Областная станция юных натуралистов Тверской области",
    { size: CAP, align: "center", h: 0.63 });

  s.addNotes(
    "А что получили сами ребята? Прежде всего — исследовательскую логику: научиться ставить гипотезу и честно её " +
    "проверять; в обеих наших работах гипотезы подтвердились. Второе — работа с данными: цифровые датчики, ЭКГ, " +
    "кардиограммы, которые надо не просто снять, а суметь интерпретировать. Третье — умение защищать своё: двадцать " +
    "девятого ноября две тысячи двадцать четвёртого года наши десятиклассницы вышли на муниципальную комиссию и " +
    "отстояли проект. Четвёртое — команда: на конференции «Теория и практика» диплом первой степени получил каждый " +
    "участник, а не один докладчик. И пятое, для меня самое важное, — преемственность: пятиклассники-ассистенты уже " +
    "сегодня работают рядом с десятым классом. (~40 сек)"
  );
}

/* ═══════════════ СЛАЙД 7. Как появилась «БиоЛаб» ═══════════════ */
{
  const s = newSlide();
  title(s, "От гранта «Школьная инициатива» — к «БиоЛаб»");

  const leftW = 6.05;
  const rightX = M + leftW + GAP;            // 6.82
  const rightW = RR - rightX;                // 6.043

  const steps = [
    ["Грант", "Гриченко Александр — победитель конкурса «Школьная инициатива».", CRIM],
    ["Защита · 29 ноября 2024 года", "Жукова Алёна и Бондаренко Софья защитили проект перед муниципальной комиссией.", NAVY],
    ["Результат", "Цифровая нейролаборатория и комфортное пространство для исследований — «БиоЛаб».", SKY],
  ];
  const stepH = 1.76;
  const pitch = (BR - CT1 - stepH) / 2;      // 2.06
  steps.forEach(([hd, b, c], i) => {
    const y = CT1 + i * pitch;
    card(s, M, y, leftW, stepH, { fill: TINT });
    circleNum(s, M + 0.25, y + (stepH - 0.52) / 2, 0.52, String(i + 1), c, 18);
    // заголовок и текст — один блок: он центрируется по карточке независимо
    // от числа строк, поэтому все три карточки «дышат» одинаково
    s.addText(
      [
        { text: hd, options: { bold: true, color: c, breakLine: true, paraSpaceAfter: 5 } },
        { text: b, options: { color: INK } },
      ],
      { x: M + 0.95, y, w: leftW - 1.20, h: stepH, fontFace: F, fontSize: 16,
        valign: "middle", margin: 0, lineSpacingMultiple: 1.12 }
    );
  });
  // соединительная линия таймлайна
  s.addShape(pres.ShapeType.line, { x: M + 0.51, y: CT1 + stepH, w: 0, h: pitch - stepH, line: { color: LINE, width: 2 } });
  s.addShape(pres.ShapeType.line, { x: M + 0.51, y: CT1 + pitch + stepH, w: 0, h: pitch - stepH, line: { color: LINE, width: 2 } });

  const ecgH = imgW(s, "s7_ecg.jpg", rightX, CT1, rightW);
  caption(s, rightX, CT1 + ecgH + 0.07, rightW, "«БиоЛаб»: цифровая нейролаборатория в работе", { size: CAP });

  card(s, rightX, 5.05, rightW, BR - 5.05, { fill: NAVY });
  s.addText("Администрация школы оказывала активное содействие",
    { x: rightX + 0.35, y: 5.05, w: rightW - 0.70, h: BR - 5.05, fontFace: F, fontSize: 19, bold: true, color: W, align: "center", valign: "middle", margin: 0, lineSpacingMultiple: 1.15 });

  s.addNotes(
    "Идея собственной научной лаборатории в кабинете биологии возникала у нас неоднократно — не хватало оборудования, " +
    "чтобы ребята выполняли настоящие исследовательские проекты. Точкой отсчёта стал Александр Гриченко: победив в " +
    "конкурсе «Школьная инициатива», он получил грант. Двадцать девятого ноября две тысячи двадцать четвёртого года " +
    "десятиклассницы Алёна Жукова и Софья Бондаренко успешно защитили проект перед муниципальной комиссией. На средства " +
    "гранта была приобретена цифровая нейролаборатория и оборудовано комфортное пространство для исследований — так " +
    "появилась «БиоЛаб». Отдельно подчеркну: администрация школы оказывала активное содействие на каждом этапе — без " +
    "этого проект остался бы идеей. (~35 сек)\n\n" +
    "TODO автору (по желанию): скан документа о победе в конкурсе «Школьная инициатива» — в материалах его нет. " +
    "Точное официальное название грантового конкурса стоит уточнить."
  );
}

/* ═══════════════ СЛАЙД 8. «БиоЛаб» в работе ═══════════════ */
{
  const s = newSlide();
  title(s, "«БиоЛаб» в работе: команда и исследования");

  const leftW = 5.35;
  const rightX = M + leftW + GAP;            // 6.12
  const rightW = RR - rightX;                // 6.743

  card(s, M, CT1, leftW, 2.02, { fill: TINT });
  s.addText("Команда", { x: M + 0.25, y: 1.27, w: leftW - 0.50, h: 0.32, fontFace: F, fontSize: 18, bold: true, color: NAVY, valign: "middle", margin: 0 });
  ["Наставник — Еременко А.М.", "9 исследователей 10 класса", "2 ассистента 5 «Б» класса"].forEach((t, i) => {
    const y = 1.66 + i * 0.48;
    card(s, M + 0.25, y, leftW - 0.50, 0.42, { fill: W });
    s.addText(t, { x: M + 0.42, y, w: leftW - 0.84, h: 0.42, fontFace: F, fontSize: 15, color: INK, valign: "middle", margin: 0 });
  });

  chipPill(s, M, 3.35, leftW, 0.42, "Преемственность поколений", CRIM, W, 15);

  const grW = 3.50;
  const grH = imgW(s, "s8_group.jpg", M + (leftW - grW) / 2, 3.93, grW);
  caption(s, M, 3.93 + grH + 0.06, leftW, "Рядом со старшеклассниками — ассистенты 5 «Б» класса", { size: CAP, align: "center" });

  const teamH = imgW(s, "s8_team.jpg", rightX, CT1, rightW);
  caption(s, rightX, CT1 + teamH + 0.07, rightW, "Регистрация биосигналов: график на экране в реальном времени", { size: CAP });

  const works = [
    ["«От сердца к цифре»", "регистрация ЭКГ, расчёт частоты сердечных сокращений", NAVY],
    ["«Адаптация сердца к нагрузкам»", "покой → нагрузка → восстановление", SKY],
  ];
  const wW = (rightW - GAP) / 2;             // 3.2215
  const wY = 4.79;
  works.forEach(([t, b, c], i) => {
    const x = rightX + i * (wW + GAP);
    card(s, x, wY, wW, 1.56, { fill: W, border: LINE, shadow: true });
    s.addText(t, { x: x + 0.22, y: wY + 0.14, w: wW - 0.44, h: 0.58, fontFace: F, fontSize: 15, bold: true, color: c, valign: "top", margin: 0, lineSpacingMultiple: 1.08 });
    s.addText(b, { x: x + 0.22, y: wY + 0.76, w: wW - 0.44, h: 0.66, fontFace: F, fontSize: 14, color: MUTED, valign: "top", margin: 0, lineSpacingMultiple: 1.1 });
  });

  card(s, M, BR - 0.56, CW, 0.56, { fill: CRIM });
  s.addText("Всероссийская НПК «Теория и практика» — диплом I степени у каждого участника",
    { x: M, y: BR - 0.56, w: CW, h: 0.56, fontFace: F, fontSize: 17, bold: true, color: W, align: "center", valign: "middle", margin: 0 });

  s.addNotes(
    "Сегодня в «БиоЛаб» работает команда из двенадцати человек: наставник, девять исследователей 10 класса и два " +
    "ассистента из 5 «Б». Это принципиальный момент: пятиклассники не наблюдают со стороны, а работают рядом со " +
    "старшими — так выстраивается преемственность поколений. На нейролаборатории выполнены две исследовательские " +
    "работы: «От сердца к цифре» — регистрация биоэлектрической активности сердца и построение кардиограмм, и " +
    "«Исследование адаптации сердца к нагрузкам» — цифровой мониторинг и интерпретация ЭКГ в покое, при нагрузке и в " +
    "фазе восстановления. Гипотезы обеих работ подтвердились. С этими работами команда победила на Всероссийской " +
    "научно-практической конференции «Теория и практика» — диплом I степени получил каждый участник. " +
    "ДАЛЕЕ ДЕМОНСТРИРУЕТСЯ ВИДЕОФРАГМЕНТ: ребята сами показывают этапы исследования и расчёты. (~40 сек + видео)\n\n" +
    "Расхождение по составу: на исходном слайде учеников было 10 фамилий (с Владимировой Дианой), в выверенных фактах — 9. " +
    "Взят вариант выверенных фактов."
  );
}

/* ═══════════════ СЛАЙД 9. Перспективные направления ═══════════════ */
{
  const s = newSlide();
  title(s, "Перспективные направления научно-исследовательской деятельности «БиоЛаб»", { size: 28 });

  const bW = (CW - 1.19) / 2;                // 5.60
  const blocks = [
    {
      x: M, accent: SKY, badge: "5–7 классы", kicker: "Классическая биология",
      project: "«Факторы успешной вегетативной репродукции лимонов сортов „Лунарио“ и „Павловский“»",
      methods: "Методы: биологический эксперимент, фенологические наблюдения, морфометрия",
      img: "s9_lemon.jpg",
      cap: "Лимон в комнатной культуре (иллюстрация). Фото: Milan Suvajac / Wikimedia Commons, CC BY-SA 4.0",
    },
    {
      x: M + bW + 1.19, accent: CRIM, badge: "9–11 классы", kicker: "Data Science и биомедицина",
      project: "«От цифры к микромиру: нейросенсорное восприятие биологических данных»",
      methods: "Статистика: t-критерий Стьюдента, U-критерий Манна–Уитни",
      img: "s9_stats.png",
      cap: "Сравнение распределений: статистическая обработка результатов (схема)",
    },
  ];

  const imgWd = 4.29;
  blocks.forEach((b) => {
    card(s, b.x, CT2, bW, BR - CT2, { fill: TINT, border: LINE });
    chipPill(s, b.x + 0.30, 1.76, 1.95, 0.38, b.badge, b.accent, W, 13);
    s.addText(b.kicker, { x: b.x + 0.30, y: 2.22, w: bW - 0.60, h: 0.34, fontFace: F, fontSize: 17, bold: true, color: NAVY, valign: "middle", margin: 0 });
    s.addText(b.project, { x: b.x + 0.30, y: 2.62, w: bW - 0.60, h: 0.80, fontFace: F, fontSize: 15, color: INK, valign: "top", margin: 0, lineSpacingMultiple: 1.1 });
    s.addText(b.methods, { x: b.x + 0.30, y: 3.48, w: bW - 0.60, h: 0.52, fontFace: F, fontSize: 14, color: MUTED, valign: "top", margin: 0, lineSpacingMultiple: 1.1 });
    imgW(s, b.img, b.x + (bW - imgWd) / 2, 4.10, imgWd);
    caption(s, b.x + 0.30, 6.48, bW - 0.60, b.cap, { size: CAP, h: 0.44, align: "center" });
  });

  // ось преемственности между блоками
  const cx = M + bW + 1.19 / 2;              // 6.665
  s.addShape(pres.ShapeType.line, { x: cx, y: 1.90, w: 0, h: 1.80, line: { color: LINE, width: 2 } });
  s.addShape(pres.ShapeType.line, { x: cx, y: 5.45, w: 0, h: 1.40, line: { color: LINE, width: 2 } });
  s.addShape(pres.ShapeType.ellipse, { x: cx - 0.45, y: 3.82, w: 0.90, h: 0.90, fill: { color: W }, line: { color: SKY, width: 1.5 } });
  s.addText("↔", { x: cx - 0.45, y: 3.82, w: 0.90, h: 0.90, fontFace: F, fontSize: 22, bold: true, color: SKY, align: "center", valign: "middle", margin: 0 });
  s.addText("преемственность", { x: cx - 0.73, y: 4.80, w: 1.46, h: 0.55, fontFace: F, fontSize: 10.5, bold: true, color: SKY, align: "center", valign: "top", margin: 0, lineSpacingMultiple: 1.05 });

  s.addNotes(
    "Лаборатория даёт нам два вектора развития — и они рассчитаны на разный возраст. Первый: классическая биология для " +
    "5–7 классов, проект по экспериментальному исследованию факторов успешной вегетативной репродукции лимонов сортов " +
    "«Лунарио» и «Павловский» в условиях школьной лаборатории — это методы классического биологического эксперимента, " +
    "фенологические наблюдения и морфометрия. Второй: Data Science и биомедицина для 9–11 классов, проект «От цифры к " +
    "микромиру: нейросенсорное восприятие биологических данных и статистический анализ в школьной лаборатории „БиоЛаб“» — " +
    "с обработкой результатов через t-критерий Стьюдента и U-критерий Манна–Уитни. Здесь встречаются нейротехнологии, " +
    "гражданская наука и математическая обработка данных. Младшие приходят в лабораторию через наблюдение и эксперимент, " +
    "старшие — через цифру и статистику, и это одна непрерывная траектория. (~40 сек)\n\n" +
    "Фото лимона — иллюстрация из Wikimedia Commons (автор Milan Suvajac, лицензия CC BY-SA 4.0), собственных кадров " +
    "по этому направлению пока нет. Схема справа нарисована, это не реальные данные."
  );
}

/* ═══════════════ СЛАЙД 10. Финал ═══════════════ */
{
  const s = newSlide();
  s.addImage({
    path: im("s10_bg.jpg"),
    x: 0, y: 0, w: 13.333, h: 7.5,
    sizing: { type: "cover", w: 13.333, h: 7.5 }, transparency: 96,
  });

  s.addText(
    [
      { text: "Конкурс — не финал, а ", options: { color: NAVY } },
      { text: "стартовая точка", options: { color: CRIM } },
    ],
    { x: 0.90, y: 2.10, w: 11.53, h: 1.45, fontFace: F, fontSize: 38, bold: true, align: "center", valign: "middle", margin: 0, lineSpacingMultiple: 1.1 }
  );

  s.addShape(pres.ShapeType.line, { x: 3.30, y: 3.78, w: 6.73, h: 0, line: { color: LINE, width: 1.5 } });

  s.addText("От кейсового задания «Большой Перемены» — к собственной цифровой лаборатории «БиоЛаб»",
    { x: 2.3665, y: 4.00, w: 8.60, h: 0.80, fontFace: F, fontSize: 18, color: MUTED, align: "center", valign: "middle", margin: 0, lineSpacingMultiple: 1.15 });

  s.addText("Спасибо за внимание!",
    { x: 0.90, y: 5.00, w: 11.53, h: 0.70, fontFace: F, fontSize: 32, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });

  s.addText("Еременко А.М., учитель биологии МБОУ СОШ №12",
    { x: 6.40, y: 6.22, w: RR - 6.40, h: 0.36, fontFace: F, fontSize: 15, bold: true, color: NAVY, align: "right", margin: 0 });
  s.addText("Вышневолоцкий муниципальный округ, 2026 год",
    { x: M, y: 6.68, w: CW, h: 0.35, fontFace: F, fontSize: 12, color: MUTED, align: "center", margin: 0 });

  s.addNotes(
    "Главный вывод нашего пути такой: конкурс — это не финал, а стартовая точка. Мы начинали с кейсовых заданий " +
    "«Большой Перемены» в обычном кабинете биологии, а сегодня у нас работает цифровая нейролаборатория «БиоЛаб», " +
    "где рядом со старшеклассниками исследования ведут пятиклассники. Одна детская инициатива, поддержанная школой, " +
    "превращается в образовательную среду для десятков ребят. Спасибо за внимание — готова ответить на вопросы. (~30 сек)"
  );
}

/* ═══════════════ СЛАЙД 11. Резерв (скрытый) ═══════════════ */
{
  const s = newSlide();
  if (!process.env.QA_SHOW_HIDDEN) s.hidden = true;
  title(s, "Резерв: материалы к вопросам");

  const leftW = 4.60;
  const rightX = M + leftW + GAP;            // 5.37
  const rightW = RR - rightX;                // 7.493

  card(s, M, CT1, leftW, 3.60, { fill: TINT });
  s.addText("Команда «БиоЛаб»", { x: M + 0.28, y: 1.33, w: leftW - 0.56, h: 0.36, fontFace: F, fontSize: 18, bold: true, color: NAVY, valign: "middle", margin: 0 });
  s.addText(
    [
      { text: "Наставник:", options: { bold: true, color: INK, breakLine: true } },
      { text: "Еременко А.М.", options: { color: MUTED, breakLine: true } },
      { text: " ", options: { fontSize: 7, breakLine: true } },
      { text: "Исследователи, 10 класс:", options: { bold: true, color: INK, breakLine: true } },
      { text: "Видонов Артём, Гужов Алексей, Елизарова Вероника, Иванова Диана, Малышева Анастасия, Мурашова Варвара, Рощин Алексей, Татушенко Егор, Тропников Иван", options: { color: MUTED, breakLine: true } },
      { text: " ", options: { fontSize: 7, breakLine: true } },
      { text: "Ассистенты, 5 «Б» класс:", options: { bold: true, color: INK, breakLine: true } },
      { text: "Виноградова Алиса, Радаева София", options: { color: MUTED } },
    ],
    { x: M + 0.28, y: 1.82, w: leftW - 0.56, h: 2.90, fontFace: F, fontSize: 13, margin: 0, valign: "top", lineSpacingMultiple: 1.16 }
  );

  const eqH = imgW(s, "s11_equipment.jpg", rightX, CT1, rightW);
  caption(s, rightX, CT1 + eqH + 0.07, rightW, "Оборудование цифровой нейролаборатории, приобретённое на средства гранта", { size: CAP });

  const thumbs = [
    ["s11_gram2022.jpg", "Благодарность\nС.В. Кириенко, 2022 год"],
    ["s11_gramota_tver.jpg", "Почётная грамота Минобразования Тверской области, 2022"],
    ["s11_atlas23.jpg", "Диплом наставника «Атласа почвенных микроорганизмов», 2023"],
    ["s11_atlas24.jpg", "Диплом наставника «Атласа почвенных микроорганизмов», 2024"],
  ];
  const thH = 1.58;
  const totalW = thumbs.reduce((a, [f]) => a + thH * aspect(f), 0);
  const thGap = (rightW - totalW) / (thumbs.length - 1);
  let tx = rightX;
  thumbs.forEach(([f, cap]) => {
    const w = imgH(s, f, tx, 4.77, thH);
    caption(s, tx - (thGap - 0.06) / 2, 4.77 + thH + 0.06, w + thGap - 0.06, cap, { size: 10, align: "center", h: 0.78 });
    tx += w + thGap;
  });

  s.addNotes(
    "Слайд служебный: держу его скрытым и открываю только если из зала спросят про состав команды, конкретное " +
    "оборудование или подтверждающие документы. Полный список дипломов и благодарностей не выношу в основной доклад " +
    "намеренно — он ломает темп. Если вопросов не будет, презентация заканчивается на слайде 10. " +
    "Дипломы «Большие Вызовы», «Экопоколение» и «Многоликая Россия» уже показаны на слайде 6 и здесь не дублируются."
  );
}

pres.writeFile({ fileName: OUT }).then(() => console.log("Готово:", OUT));
