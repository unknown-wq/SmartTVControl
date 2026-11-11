/* =====================================================================
 * 03_names.js — procedural name generators (Russian transliteration style)
 * OWNER: architect. Read-only for other modules.
 * Names are bare proper nouns; UI/Log wrap kingdoms/cities in «guillemets» so no declension is needed.
 * ===================================================================== */

const Names = (() => {
  const P = {
    human: {
      mA: ['Альд', 'Бер', 'Вил', 'Гар', 'Дор', 'Эд', 'Ив', 'Кай', 'Лот', 'Мор', 'Нор', 'Осв', 'Рол', 'Сэр', 'Тор', 'Ульф', 'Хар', 'Ярл', 'Бран', 'Годв'],
      mB: ['рик', 'вин', 'мунд', 'берт', 'ольд', 'ан', 'ек', 'ас', 'ар', 'он', 'ий', 'мар', 'ред'],
      fA: ['Ал', 'Бел', 'Вер', 'Гел', 'Дар', 'Эл', 'Ив', 'Лил', 'Мар', 'Нин', 'Ор', 'Роз', 'Сиб', 'Тал', 'Фрей', 'Яр', 'Ада', 'Мил'],
      fB: ['а', 'ена', 'ина', 'лия', 'ра', 'ета', 'ана', 'мила', 'ея', 'берта', 'гунда', 'ейна'],
      pA: ['Вест', 'Ост', 'Нор', 'Эльд', 'Брен', 'Кал', 'Дар', 'Лун', 'Мир', 'Тар', 'Вир', 'Стар', 'Хол', 'Зем', 'Рив', 'Аран', 'Дорв', 'Сильв', 'Грен', 'Тир'],
      pB: ['град', 'холм', 'бург', 'ворд', 'ли', 'ин', 'стон', 'мар', 'дор', 'ия', 'тон', 'вик', 'берг', 'ейн'],
      cA: ['Кам', 'Бел', 'Сер', 'Ржан', 'Чёрн', 'Вол', 'Ор', 'Кров', 'Зла', 'Мед'], cB: ['ых', 'ов', 'ины', 'ичи', 'ские'],
    },
    orc: {
      mA: ['Гр', 'Мог', 'Ург', 'Заг', 'Брак', 'Тук', 'Шак', 'Дрог', 'Нагр', 'Горб', 'Кур', 'Лаз', 'Хруш', 'Мур', 'Кагр'],
      mB: ['ак', 'ук', 'аш', 'ог', 'ун', 'гар', 'мок', 'зуг', 'рак', 'ош', 'ург'],
      fA: ['Уш', 'Гр', 'Мог', 'Баз', 'Шар', 'Лур', 'Яг', 'Дра'],
      fB: ['та', 'азза', 'ашка', 'уга', 'ога', 'ула', 'ага', 'ыка'],
      pA: ['Груш', 'Кра', 'Мор', 'Баг', 'Гор', 'Драк', 'Зур', 'Рог', 'Тар', 'Хаг', 'Ург', 'Чар'],
      pB: ['гор', 'мок', 'нак', 'раш', 'дум', 'зуг', 'тар', 'баш', 'гаш', 'ног'],
      cA: ['Чёрн', 'Кров', 'Желез', 'Кост', 'Гнил', 'Рван', 'Тёмн'], cB: ['ый Клык', 'ый Коготь', 'ый Кулак', 'ая Пасть', 'ый Череп'],
    },
    elf: {
      mA: ['Эл', 'Ти', 'Ла', 'Аэ', 'Ил', 'Фэ', 'Сил', 'Ар', 'Кэ', 'Мэ', 'Лэ', 'Ни', 'Ва', 'Эр'],
      mB: ['ариэн', 'андил', 'ион', 'орин', 'иэль', 'эрин', 'вэн', 'алас', 'ондиль', 'ильмар'],
      fA: ['Эл', 'Ти', 'Ла', 'Ни', 'Ар', 'Ли', 'Ми', 'Си', 'Ва', 'Аэ'],
      fB: ['ариэль', 'ана', 'илия', 'эриэль', 'ивэн', 'уриэль', 'елла', 'ианна', 'энвэ'],
      pA: ['Лот', 'Эрил', 'Сил', 'Тал', 'Лаур', 'Аэл', 'Ил', 'Фэн', 'Мирил', 'Нэр', 'Кэл', 'Элл'],
      pB: ['лориэн', 'ариэль', 'ондор', 'иллон', 'эрин', 'ания', 'ивэль', 'аланд', 'орин'],
      cA: ['Звёздн', 'Лунн', 'Лист', 'Серебрян', 'Тенист', 'Рассвет'], cB: ['ые', 'ая Ветвь', 'ый Дом', 'ые Ветры'],
    },
  };
  const KEYS = ['human', 'orc', 'elf'];
  const TITLES = ['Королевство', 'Орда', 'Лесное княжество'];

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function used() { const m = S.mod.names || (S.mod.names = { used: {} }); return m.used; }

  function make(a, b) { return cap(R.pick(a) + R.pick(b)); }

  return {
    /** first name. sex: Const.SEX.M / F */
    person(race, sex) {
      const p = P[KEYS[race]];
      return sex === Const.SEX.F ? make(p.fA, p.fB) : make(p.mA, p.mB);
    },
    /** family / clan name (a short word) */
    clan(race) {
      const p = P[KEYS[race]];
      return cap(R.pick(p.cA) + R.pick(p.cB));
    },
    /** place name root, unique within the world while possible. Used for cities AND kingdoms. */
    place(race) {
      const p = P[KEYS[race]];
      const u = used();
      let n = '';
      for (let i = 0; i < 12; i++) {
        n = make(p.pA, p.pB);
        if (!u[n]) break;
      }
      u[n] = 1;
      return n;
    },
    /** kingdom proper name (bare) */
    kingdom(race) { return this.place(race); },
    /** word for a state of the race: Королевство / Орда / Лесное княжество */
    title(race) { return TITLES[race] || 'Королевство'; },
    /** Log-friendly reference «Name». Accepts a kingdom or city object (or null). */
    ref(ent) { return ent ? '«' + ent.name + '»' : '«?»'; },
    /** simple city size word by population */
    cityWord(pop) { return pop < 8 ? 'Деревня' : pop < 25 ? 'Посёлок' : pop < 60 ? 'Город' : 'Крупный город'; },
    /** Russian unit title: "Король"/"Королева"/"Вождь"/"Вожак"/"Князь"/"Княгиня" */
    ruler(race, sex) {
      if (race === Const.RACE.ORC) return sex === Const.SEX.F ? 'Вождиха' : 'Вождь';
      if (race === Const.RACE.ELF) return sex === Const.SEX.F ? 'Княгиня' : 'Князь';
      return sex === Const.SEX.F ? 'Королева' : 'Король';
    },
  };
})();
