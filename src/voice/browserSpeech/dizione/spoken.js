// Text -> the words to say: numbers, money, dates, times, units, codes, addresses and abbreviations
// written out by rule, before a voice's own phonemizer sees the text. A port of the text rules of
// dizione (github.com/n4ze3m/dizione, src/dizione/normalize.py and data/*.txt, Apache-2.0, see
// LICENSE here), its `Normalizer.rewrite`. Not ported: inline {phones}, accent folding, and the
// word-level pass (chat words, Roman numerals); the voices' own lexicons handle words.
/* eslint-disable */
import { ABBREVIATIONS, CHAT, ENDINGS, EXACT_UNITS, UNITS } from "./tables.js";

const SPELL = "", END = "";
const ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " +
  "seventeen eighteen nineteen").split(" ");
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const SCALES = ["thousand", "million", "billion", "trillion", "quadrillion"];
const ORDINAL = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
const MONTHS = "January February March April May June July August September October November December".split(" ");
const MONTH_NUMBER = Object.fromEntries(MONTHS.map((name, index) => [name.toLowerCase().slice(0, 3), index + 1]));
const MONTH_PATTERN = MONTHS.join("|") + "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const DAY_PATTERN = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Thurs|Thur|Tues|Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const CURRENCY = { "$": ["dollar", "dollars", "cent", "cents"], "£": ["pound", "pounds", "penny", "pence"],
  "€": ["euro", "euros", "cent", "cents"], "¥": ["yen", "yen", "", ""], "₹": ["rupee", "rupees", "paisa", "paise"] };
Object.assign(CURRENCY, { USD: CURRENCY["$"], EUR: CURRENCY["€"], GBP: CURRENCY["£"], JPY: CURRENCY["¥"], INR: CURRENCY["₹"],
  CHF: ["Swiss franc", "Swiss francs", "centime", "centimes"], CAD: ["Canadian dollar", "Canadian dollars", "cent", "cents"],
  AUD: ["Australian dollar", "Australian dollars", "cent", "cents"], CNY: ["yuan", "yuan", "", ""] });
const CURRENCY_CODES = "USD|EUR|GBP|JPY|INR|CHF|CAD|AUD|CNY";
const SCALE_LETTER = { k: "thousand", m: "million", b: "billion", bn: "billion", t: "trillion" };
const FRACTION = { 2: ["half", "halves"], 4: ["quarter", "quarters"] };
const SYMBOL_WORDS = { "&": "and", "@": "at", "+": "plus", "=": "equals", "%": "percent", "×": "times", "÷": "divided by",
  "±": "plus or minus", "©": "copyright", "§": "section", "°": "degrees", "≥": "greater than or equal to",
  "≤": "less than or equal to", "≠": "not equal to", "≈": "approximately", "∞": "infinity", "√": "square root of", "π": "pi" };
const COMPARISONS = { ">=": "greater than or equal to", "<=": "less than or equal to", "!=": "not equal to" };
const words = (text) => new Set(text.split(" "));
const SENTENCE_STARTERS = words("the he she it i we they this that there but and in on at a an if when what why how who my our " +
  "you then so now after before however");
const YEAR_CONTEXT = words("in since by from until till before after during around circa of year early late mid summer winter " +
  "spring fall autumn class");
const PHONE_WORDS = words("call dial ring phone telephone tel mobile cell fax hotline text sms whatsapp");
const PHONE_LINKS = words("to on at or us me him her them back");
const PIN_WORDS = words("code pin extension ext passcode password zip postcode cvv cvc otp");
const STRONG_WORDS = words("number id reference ref serial account tracking booking confirmation");
const WEAK_WORDS = words("order ticket invoice case claim policy receipt transaction parcel shipment container payment " +
  "reservation membership customer batch lot item job issue bug request");
const LINK_WORDS = words("is was are were ends ending in with starts starting begins beginning");
const NOT_COUNTED = words("is was has does goes ships arrives departs leaves shows needs blocks remains includes contains " +
  "says reads starts ends closes opens runs takes comes this his its us as yes plus minus less");
const NUMBERED = words("ref reference serial account order invoice tracking part model phone tel fax id room flight case " +
  "ticket policy licence license booking customer vat tax reg registration");
const DATE_BEFORE = words("on dated due until till by since from before after for shipped delivered arriving arrives arrive " +
  "arrived expires expired ends ending starts starting begins beginning monday tuesday wednesday thursday friday saturday " +
  "sunday mon tue tues wed thu thur thurs fri sat sun");
const CLASSIC_FRACTIONS = new Set([2, 3, 4, 5, 6, 8, 10, 16, 32, 64, 100]);
const RATIO_WORDS = words("ratio ratios scale odds aspect mix split proportion");
const DURATION_WORDS = words("lasted took duration runtime recording video clip track lap pace length long");
const CLOCK_WORDS = words("window slot open opens opening hours shift session served service available booked appointment " +
  "delivery arrive arrives arriving");
const CAPITAL_WORDS = words("IN ON AT TO OF BY OR IS AS IF NO SO WE HE MY ME DO GO UP AN AM PM BE IT US THE AND FOR BUT NOT ALL");
const SHORT_WORDS = words("my to in on of go up no do me we us it is at by be so or an as if he hi ok");
const ZONES = "ET|CT|MT|PT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|GMT|UTC|BST|CET|CEST|IST|AEST|AEDT|JST";
const SIZES = "XXXL|XXL|XXS|XL|XS|S|M|L";
const LENGTHS = "mm|cm|km|m|ft|in|inch|inches|feet|foot|metres?|meters?|yards?|yd|px|pixels?";
const VERSIONED = "version|ver|release|firmware|patch|kernel|build|python|node|nodejs|ios|ipados|macos|watchos|tvos|android|" +
  "chrome|firefox|safari|java|php|ruby|rust|swift|kotlin|golang|django|rails|react|angular|vue|docker|" +
  "kubernetes|ubuntu|debian|fedora|windows|linux|postgres|postgresql|mysql|redis|numpy|pytorch|tensorflow|cuda|" +
  "xcode|gcc|clang|unity|minecraft|typescript|bluetooth|usb|hdmi|opengl|vulkan|directx|upgrade[ds]?|update[ds]?|downgrade[ds]?";
const SEPARATORS = { ".": "dot", "/": "slash", "@": "at", "-": "dash", "_": "underscore", ":": "colon", "=": "equals", "&": "and", "+": "plus" };
const HALF_DAY = String.raw`(?:\s?([AaPp])\.[Mm]\.?|\s?([AaPp])[Mm]\b)`;
const AMOUNT = String.raw`(?<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<fraction>\d+))?`;
const MONEY = new RegExp(String.raw`(?:(?<![\w.])(?<minus>-)\s?)?(?<symbol>[$£€¥₹]|(?<![A-Za-z])(?:${CURRENCY_CODES})(?![A-Za-z]))\s?` +
  String.raw`(?<inner>-)?${AMOUNT}(?:\s?(?<scale>thousand|million|billion|trillion|bn|[kKmMbB])(?![A-Za-z]))?`, "g");
const MONEY_AFTER = new RegExp(String.raw`(?<![\w.,])${AMOUNT}\s?(?<symbol>${CURRENCY_CODES})(?![A-Za-z])`, "g");
const VULGAR = /(?<![\d.,/])(?:(\d+)\s?)?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])/g;
const ADDRESS = new RegExp(
  String.raw`(?<url>(?:https?:\/\/|www\.)[^\s<>"']+)` +
  String.raw`|(?<mail>[\w.+-]+@[\w-]+(?:\.[\w-]+)+)` +
  String.raw`|(?<file>(?<![\w@./-])(?<folder>\/?(?:[\w~-]+\/)+)?(?<stem>[\w-]+(?:\.[\w-]+)*)\.(?<ending>[A-Za-z][A-Za-z0-9]{0,9})` +
  String.raw`(?![\w-])(?<path>\/[^\s<>"']*)?)`, "g");
const DAY_RANGE = new RegExp(String.raw`\b(${DAY_PATTERN}|${MONTH_PATTERN})\b(\.?)\s?[-–]\s?(${DAY_PATTERN}|${MONTH_PATTERN})\b(\.?)`, "g");
const RATIO = /(?<![\d:.,])(\d{1,3}):(\d{1,3}(?:,\d{3})+|\d+)(?![\d:]|[.,]\d)/g;
const CODE = /(?<![\w.,/-])(#)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)(?![\w-]|[.,]\d)/g;
const SLASHED = /(?<![\w.,/-])(\d+(?:\/\d+){2,})(?![\w/]|[.,]\d)/g;
// dizione's pattern has a conditional group (a trailing pair of capitals only after a leading one); as two branches here.
const GROUP_CORE = String.raw`[A-Z0-9]*\d[A-Z0-9]*(?: [A-Z0-9]*\d[A-Z0-9]*)+`;
const GROUPED = new RegExp(String.raw`(?<![\w.,:/#+-])(\+)?(?:([A-Z]{2}) (${GROUP_CORE})(?: ([A-Z]{2})(?!\w))?|(${GROUP_CORE}))` +
  String.raw`(?!\w|[.,:/-]\d|\s?[%°])`, "g");
const GLUED = /(?<![\w'.])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+(?![\w']|\.\d)/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}☀-➿\u{1F1E6}-\u{1F1FF}←-⇿⬀-⯿️‍⃣]+/gu;
const EMOTICON = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:[:;=]['^-]?[DPpOo3|/\\*\]\[}{><]+|[)(\]\[][-^']?[:;=]|<3+|<\/3|\^_?\^|-_-|[oO]_[oO]|>_<|T_T|\\o\/|:'[()])(?![A-Za-z0-9])` +
  String.raw`|[:;=]['^-]?[)(]+`, "g");


// ------------------------------------------------------------------------------------------------ numbers as words
const isUpper = (s) => s !== s.toLowerCase() && s === s.toUpperCase();
const isAlpha = (s) => /^\p{L}+$/u.test(s);
const isDigits = (s) => /^\d+$/.test(s);
const int = (s) => Number.parseInt(s, 10);

export function cardinal(number) {
  if (number < 0) return "minus " + cardinal(-number);
  if (number < 20) return ONES[number];
  if (number < 100) {
    const tens = Math.floor(number / 10), ones = number % 10;
    return TENS[tens - 2] + (ones ? " " + ONES[ones] : "");
  }
  if (number < 1000) {
    const rest = number % 100;
    return ONES[Math.floor(number / 100)] + " hundred" + (rest ? " " + cardinal(rest) : "");
  }
  if (number >= 1000 ** (SCALES.length + 1)) return digits(String(number));
  const parts = [];
  for (let power = SCALES.length; power > 0; power--) {
    const unit = 1000 ** power, count = Math.floor(number / unit);
    number %= unit;
    if (count) parts.push(cardinal(count) + " " + SCALES[power - 1]);
  }
  if (number) parts.push(cardinal(number));
  return parts.join(" ");
}

export function ordinal(number) {
  const list = cardinal(number).split(" ");
  const last = list[list.length - 1];
  list[list.length - 1] = ORDINAL[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return list.join(" ");
}

const digits = (text, zero = "zero") => [...text].filter((c) => /\d/.test(c)).map((c) => (c === "0" ? zero : ONES[+c])).join(" ");

export function year(number) {
  if (!(number >= 1000 && number <= 2999)) return cardinal(number);
  const high = Math.floor(number / 100), low = number % 100;
  if (low === 0) return high % 10 === 0 ? cardinal(number) : cardinal(high) + " hundred";
  if (high === 20 && low < 10) return "two thousand " + ONES[low];
  return cardinal(high) + (low < 10 ? " oh " + ONES[low] : " " + cardinal(low));
}

function pairs(number) {
  const high = Math.floor(number / 100), low = number % 100;
  if (!(number >= 100 && number <= 9999) || (low === 0 && (high < 10 || high % 10 === 0))) return cardinal(number);
  if (low === 0) return cardinal(high) + " hundred";
  return cardinal(high) + (low < 10 ? " oh " + ONES[low] : " " + cardinal(low));
}

function numberWords(text) {
  const plain = text.replace(/,/g, "");
  const dot = plain.indexOf(".");
  const whole = dot < 0 ? plain : plain.slice(0, dot), fraction = dot < 0 ? "" : plain.slice(dot + 1);
  if (fraction) return (whole ? cardinal(int(whole)) : "") + " point " + digits(fraction);
  // dizione's limit is 18 digits; a JS number is exact to 15.
  if ((whole.length > 1 && whole.startsWith("0")) || whole.length > 15) return digits(whole);
  return cardinal(int(whole));
}

function duration(hours, minutes, seconds) {
  const parts = [[hours, "hour"], [minutes, "minute"], [seconds, "second"]]
    .filter(([count]) => count)
    .map(([count, name]) => `${cardinal(count)} ${count === 1 ? name : name + "s"}`);
  if (parts.length < 2) return parts[0] ?? "zero seconds";
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

function pluralOf(spoken) {
  const at = spoken.lastIndexOf(" ");
  const head = at < 0 ? "" : spoken.slice(0, at), last = spoken.slice(at + 1);
  return (head ? head + " " : "") + (last.endsWith("y") ? last.slice(0, -1) + "ies" : last + "s");
}

function fractionWords(top, bottom, article = false) {
  const [one, many] = FRACTION[bottom] ?? [ordinal(bottom), ordinal(bottom) + "s"];
  if (top !== 1) return `${cardinal(top)} ${many}`;
  return (article ? ("aeiou".includes(one[0]) ? "an " : "a ") : "one ") + one;
}

const versionPart = (part) => (part.length > 2 ? digits(part) : numberWords(part));
const minor = (part) => (part.startsWith("0") ? digits(part, "oh") : cardinal(int(part)));
const shortNumber = (text) => !text.startsWith("0") && (text.length <= 2 || /^0+$/.test(text.slice(1)));
const spelled = (letters) => `${SPELL}${letters}${END}`;

function before(text, position, count = 4) {
  const parts = text.slice(Math.max(0, position - 80), position).split(/[.!?;…]\s|[()"]/);
  return (parts[parts.length - 1].match(/[A-Za-z]+/g) ?? []).map((word) => word.toLowerCase()).slice(-count);
}

function identifier(text, position) {
  const list = before(text, position);
  if (list.length === 0) return null;
  const last = list[list.length - 1];
  if (PHONE_WORDS.has(last) || (PHONE_LINKS.has(last) && list.slice(-3, -1).some((word) => PHONE_WORDS.has(word)))) return "phone";
  let index = list.length - 1;
  while (index > 0 && LINK_WORDS.has(list[index])) index--;
  for (const [kind, group] of [["phone", PHONE_WORDS], ["pin", PIN_WORDS], ["strong", STRONG_WORDS], ["weak", WEAK_WORDS]]) {
    if (group.has(list[index])) return kind;
  }
  return last === "enter" ? "enter" : null;
}

function addressDigits(text) {
  if (text.length <= 2 && !(text.length === 2 && text[0] === "0")) return cardinal(int(text));
  if (text.length === 4 && int(text) >= 1900 && int(text) <= 2099) return year(int(text));
  return digits(text);
}

// ------------------------------------------------------------------------------------------------ rewriting
/** Python's re.sub over a global regex: `fn` gets a match ({ group(n), groups, start, end, string }) and returns the
 *  replacement, or [replacement, extra characters consumed after the match]. */
function sub(regex, text, fn) {
  let out = "", at = 0;
  for (const m of text.matchAll(regex)) {
    if (m.index < at) continue;
    const match = { group: (n = 0) => m[n], groups: m.groups ?? {}, start: m.index, end: m.index + m[0].length, string: text };
    const result = fn(match);
    const [replacement, extra] = Array.isArray(result) ? result : [result, 0];
    out += text.slice(at, m.index) + replacement;
    at = match.end + extra;
  }
  return out + text.slice(at);
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export class Normalizer {
  /** isWord(lower case spelling): whether the voice's dictionary knows the word (dizione's is_word). */
  constructor(isWord = () => true) {
    this.isWord = isWord;
    const names = [...new Set([...Object.keys(UNITS), ...Object.keys(EXACT_UNITS)].map(escape))]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    this.unitNames = names.join("|");
    this.unit = new RegExp(String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?:[-–](\d[\d,]*(?:\.\d+)?))?\s?(${this.unitNames})(?![A-Za-z])`, "gi");
    this.area = /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(km|cm|mm|m|ft|mi|yd|in)([²³])/g;
    this.areaPlain = /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(km|cm|mm|m|ft)([23])(?!\w)/g;
    this.dayFirst = false;
    this.dated = false;
  }

  amount(symbol, whole, fraction, scale) {
    const [one, many, cent, cents] = CURRENCY[symbol];
    if (scale) {
      const said = SCALE_LETTER[scale.toLowerCase()] ?? scale.toLowerCase();
      return `${numberWords(whole + (fraction ? "." + fraction : ""))} ${said} ${many}`;
    }
    if (fraction && (fraction.length > 2 || !cent)) return `${numberWords(whole + "." + fraction)} ${many}`;
    const amount = int(whole), change = int((fraction || "0").padEnd(2, "0"));
    const parts = [];
    if (amount || !change) parts.push(`${cardinal(amount)} ${amount === 1 ? one : many}`);
    if (change && cent) parts.push(`${cardinal(change)} ${change === 1 ? cent : cents}`);
    return parts.join(" and ");
  }

  money(match) {
    const found = match.groups;
    const said = this.amount(found.symbol, found.whole.replace(/,/g, ""), found.fraction, found.scale);
    return (found.minus || found.inner ? " minus " : " ") + said + " ";
  }

  static halfDay(match, dotted, plain) {
    if (!(dotted || plain)) return "";
    const following = match.string.slice(match.end).trimStart();
    const first = following.match(/^[A-Za-z']+/);
    const closes = Boolean(dotted) && match.group(0).endsWith(".") &&
      (!following || (isUpper(following[0]) && first !== null && SENTENCE_STARTERS.has(first[0].toLowerCase())));
    return `${SPELL}${(dotted || plain).toUpperCase()}M${END}${closes ? " ." : ""} `;
  }

  time(match) {
    const hour = int(match.group(1)), minute = int(match.group(2)), second = match.group(3);
    const half = match.group(4) || match.group(5);
    const list = before(match.string, match.start, 3);
    if (second !== undefined && !half && !(list.length && list[list.length - 1] === "at")) {
      return ` ${duration(hour, minute, int(second))} `;
    }
    if (hour > 24 && second === undefined && !half) {
      const after = match.string.slice(match.end).match(/^\s*([A-Za-z]+)/);
      if (list.some((word) => DURATION_WORDS.has(word)) || (after && DURATION_WORDS.has(after[1].toLowerCase()))) {
        return ` ${duration(0, hour, minute)} `;
      }
      return ` ${cardinal(hour)} ${minute < 10 ? "oh " : ""}${cardinal(minute)} `;
    }
    if (hour > 24) return match.group(0);
    let said = cardinal(hour);
    if (minute === 0) {
      if (half) { /* "ten A M" */ }
      else if (hour === 0) said = "midnight";
      else if (hour > 12) said += " hundred";
      else said += " o'clock";
    } else {
      said += (minute < 10 ? " oh " : " ") + cardinal(minute);
    }
    if (second) said += " and " + cardinal(int(second)) + (int(second) === 1 ? " second" : " seconds");
    return ` ${said} ` + Normalizer.halfDay(match, match.group(4), match.group(5));
  }

  dotTimes(match) {
    const following = match.string.slice(match.end);
    if (int(match.group(1)) > 23 || int(match.group(4)) > 23 ||
        !before(match.string, match.start).some((word) => CLOCK_WORDS.has(word)) ||
        new RegExp(String.raw`^\s?(?:%|percent|million|billion|${this.unitNames})(?![A-Za-z])`, "i").test(following)) {
      return match.group(0);
    }
    return `${match.group(1)}:${match.group(2)}${match.group(3)}${match.group(4)}:${match.group(5)}`;
  }

  ratio(match) {
    const first = match.group(1), second = match.group(2);
    if (first.length <= 2 && second.length === 2 && "012345".includes(second[0])) {
      const after = match.string.slice(match.end).match(/^\s*([A-Za-z]+)/);
      if (!(before(match.string, match.start, 3).some((word) => RATIO_WORDS.has(word)) ||
            (after && RATIO_WORDS.has(after[1].toLowerCase())))) {
        return match.group(0);
      }
    }
    return ` ${numberWords(first)} to ${numberWords(second)} `;
  }

  date(month, day, yearText, the = false) {
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
    let said = the ? `the ${ordinal(day)} of ${MONTHS[month - 1]}` : `${MONTHS[month - 1]} ${ordinal(day)}`;
    if (yearText) {
      said += " " + (yearText.length === 4 ? year(int(yearText)) : (int(yearText) < 10 ? "oh " : "") + cardinal(int(yearText)));
    }
    return ` ${said} `;
  }

  slashDate(match) {
    let first = int(match.group(1)), second = int(match.group(2));
    if ((first > 12 && 12 >= second) || (this.dayFirst && second <= 12)) [first, second] = [second, first];
    return this.date(first, second, match.group(3)) ?? match.group(0);
  }

  dotDate(match) {
    let day = int(match.group(1)), month = int(match.group(2));
    if (month > 12 && 12 >= day) [day, month] = [month, day];
    return this.date(month, day, match.group(3)) ?? match.group(0);
  }

  dayMonth(match) {
    const month = match.group(2);
    const spoken = this.date(MONTH_NUMBER[month.toLowerCase().slice(0, 3)], int(match.group(1)), match.group(4), true);
    if (spoken === null) return match.group(0);
    return spoken + (match.group(3) && MONTHS.includes(month) ? ". " : "");
  }

  daysOfMonth(match) {
    const monthFirst = /\p{L}/u.test(match.group(1)[0]);
    const [month, a, b] = monthFirst ? [match.group(1), match.group(2), match.group(3)] : [match.group(3), match.group(1), match.group(2)];
    const first = int(a), second = int(b);
    if (!(first >= 1 && first <= 31 && second >= 1 && second <= 31)) return match.group(0);
    const name = MONTHS[MONTH_NUMBER[month.toLowerCase().slice(0, 3)] - 1];
    const said = monthFirst ? `${name} ${ordinal(first)} to ${ordinal(second)}` : `the ${ordinal(first)} to the ${ordinal(second)} of ${name}`;
    return ` ${said}${match.group(4) ? " " + year(int(match.group(4))) : ""} `;
  }

  dayRange(match) {
    const names = [match.group(1), match.group(3)].map((name) => {
      const key = name.toLowerCase();
      return key in ABBREVIATIONS ? ABBREVIATIONS[key][1] : DAY_NAMES[key] ?? name;
    });
    const following = match.string.slice(match.end).trimStart();
    const first = following.match(/^[A-Za-z']+/);
    const ends = Boolean(match.group(4)) &&
      (!following || (isUpper(following[0]) && first !== null && SENTENCE_STARTERS.has(first[0].toLowerCase())));
    return `${names[0]} to ${names[1]}${ends ? " ." : ""}`;
  }

  shortDate(match) {
    const firstText = match.group(1), secondText = match.group(2);
    if (firstText.length > 2 || secondText.length > 2) return null;
    let first = int(firstText), second = int(secondText);
    const list = before(match.string, match.start);
    if (first >= 1 && first <= 12 && second >= 20 && second <= 49 && list.includes("card")) {
      return ` ${MONTHS[first - 1]} ${year(2000 + second)} `;
    }
    const last = list.length ? list[list.length - 1] : "";
    const classic = first < second && CLASSIC_FRACTIONS.has(second);
    const zero = (firstText.length === 2 && firstText[0] === "0") || (secondText.length === 2 && secondText[0] === "0");
    if (!(zero || (first > 12 && first <= 31 && second <= 12 && !(first === 24 && second === 7)) ||
          (DATE_BEFORE.has(last) && (!classic || last === "on")) || (this.dated && !classic && first !== second))) {
      return null;
    }
    if (first > 12 || (this.dayFirst && second <= 12)) [first, second] = [second, first];
    return this.date(first, second);
  }

  fraction(match) {
    const spoken = this.shortDate(match);
    if (spoken) return spoken;
    const top = int(match.group(1)), bottom = int(match.group(2));
    if ((top === 24 && bottom === 7) || top === bottom) return ` ${cardinal(top)} ${cardinal(bottom)} `;
    if (!(top > 0 && top < 100) || !(bottom > 1 && bottom <= 100)) return ` ${cardinal(top)} over ${cardinal(bottom)} `;
    return ` ${fractionWords(top, bottom)} `;
  }

  mixedFraction(match) {
    const top = int(match.group(2)), bottom = int(match.group(3));
    if (!(top > 0 && top < bottom)) return match.group(0);
    return ` ${numberWords(match.group(1))} and ${fractionWords(top, bottom, true)} `;
  }

  vulgar(match) {
    const [top, bottom] = match.group(2).normalize("NFKC").split("⁄").map(int);
    if (match.group(1) === undefined) return ` ${top}/${bottom} `;
    return ` ${cardinal(int(match.group(1)))} and ${fractionWords(top, bottom, true)} `;
  }

  phone(match) {
    const groups = [1, 2, 3, 4].map((n) => match.group(n)).filter(Boolean);
    return " " + groups.map((group) => (group === "800" ? "eight hundred" : digits(group, "oh"))).join(", ") + " ";
  }

  measure(match) {
    const unit = match.group(3);
    const names = EXACT_UNITS[unit] ?? UNITS[unit.toLowerCase()];
    const next = match.string.slice(match.end, match.end + 1);
    if (names === undefined || (unit.length === 1 && ["-", "'", "/"].includes(next))) return match.group(0);
    const [one, many] = names;
    const value = match.group(1), upper = match.group(2);
    // dizione's pattern also takes a full stop after the unit when a small letter follows ("5 min. walk").
    const stop = /^\.\s+[a-z]/.test(match.string.slice(match.end)) ? 1 : 0;
    if (upper) return [` ${numberWords(value)} to ${numberWords(upper)} ${many} `, stop];
    return [` ${numberWords(value)} ${value === "1" || value === "1.0" ? one : many} `, stop];
  }

  square(match) {
    const unit = match.group(2);
    const [one, many] = unit === "in" ? ["inch", "inches"] : EXACT_UNITS[unit] ?? UNITS[unit];
    const kind = "²2".includes(match.group(3)) ? "square" : "cubic";
    return ` ${numberWords(match.group(1))} ${kind} ${match.group(1) === "1" || match.group(1) === "1.0" ? one : many} `;
  }

  counted(text, end) {
    const after = text.slice(end).match(/^\s*([A-Za-z]+)/);
    if (!after) return false;
    const word = after[1].toLowerCase();
    if (["people", "men", "women", "children", "feet", "miles"].includes(word)) return true;
    return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !NOT_COUNTED.has(word) && this.isWord(word.slice(0, -1));
  }

  number(match) {
    const text = match.string, value = match.group(0);
    const plain = value.replace(/,/g, "");
    if (!plain.includes(".") && !value.includes(",") && !plain.startsWith("0") && plain.length > 2) {
      const kind = identifier(text, match.start);
      const limit = { phone: 3, pin: 3, strong: 4, enter: 4, weak: 5 }[kind] ?? 7;
      if (plain.length >= limit && !(kind === null && plain.endsWith("000")) &&
          !(kind === "enter" && plain.length === 4 && int(plain) >= 1900 && int(plain) <= 2099) &&
          !([null, "phone", "weak"].includes(kind) && this.counted(text, match.end))) {
        return ` ${digits(plain, kind === "phone" ? "oh" : "zero")} `;
      }
    }
    if (!plain.includes(".") && !value.includes(",") && plain.length === 4 && !plain.startsWith("0")) {
      const number = int(plain);
      const beforeWords = text.slice(0, match.start).slice(-24).match(/[A-Za-z]+/g) ?? [];
      const after = text.slice(match.end).match(/^\s*([A-Za-z]+)/);
      const counted = Boolean(after) && /(?:[^s]s|people|men|women|children|feet|miles)$/.test(after[1].toLowerCase());
      const lastBefore = beforeWords.length ? beforeWords[beforeWords.length - 1].toLowerCase() : "";
      const dated = Boolean(lastBefore) && (YEAR_CONTEXT.has(lastBefore) || lastBefore.slice(0, 3) in MONTH_NUMBER);
      const model = text.slice(0, match.start).match(/(?<![A-Za-z])([A-Z]{2,5}) $/);
      if (model && !CAPITAL_WORDS.has(model[1]) && !counted) return ` ${pairs(number)} `;
      if ((number >= 1100 && number <= 1999) || (number >= 2000 && number <= 2099 && (dated || !counted))) return ` ${year(number)} `;
    }
    return ` ${numberWords(value)} `;
  }

  readsAsWord(letters) {
    const lower = letters.toLowerCase();
    if (lower.length < 3 || !this.isWord(lower)) return false;
    return lower.length > 3 || ["s", "es", "ed", "ing"].some((ending) => this.isWord(lower + ending));
  }

  static alnum(group, zero = "zero") {
    return (group.match(/[A-Za-z]+|\d+/g) ?? []).map((run) => (isDigits(run) ? digits(run, zero) : spelled(run))).join(" ");
  }

  static digitGroups(groups, zero = "zero") {
    if (groups.every((group) => shortNumber(group) && group.length <= 2)) return groups.map((group) => cardinal(int(group))).join(" , ");
    return groups.map((group) => digits(group, zero)).join(" , ");
  }

  codeWords(groups, match) {
    const token = groups.join("-");
    if (!/\d/.test(token)) return null;
    const kinds = groups.map((g) => (isDigits(g) ? "d" : /\d/.test(g) ? "m" : isUpper(g) ? "u" : "l"));
    if (kinds.every((kind) => kind === "d")) {
      if (groups.length === 2) {
        const years = groups.every((g) => g.length === 4 && int(g) >= 1000 && int(g) <= 2100);
        if (!(match.group(1) || groups.some((g) => g.length > 1 && g[0] === "0") ||
              (Math.min(...groups.map((g) => g.length)) >= 4 && !years) ||
              ["strong", "pin"].includes(identifier(match.string, match.start)))) {
          return null;
        }
      }
      return Normalizer.digitGroups(groups);
    }
    if (groups.length === 2 && kinds[1] === "d" && "ul".includes(kinds[0])) {
      const [letters, number] = groups;
      if ((kinds[0] === "l" && letters.length > 1) || this.readsAsWord(letters)) return null;
      if (shortNumber(number)) return `${spelled(letters)} ${cardinal(int(number))}`;
      return `${spelled(letters)} , ${digits(number)}`;
    }
    if (groups.length === 2 && kinds[0] === "d" && (kinds[1] === "l" || groups[1].length === 1 || /^\d+[A-Za-z]+$/.test(groups[1]))) {
      return null;
    }
    if (kinds.some((kind, i) => (kind === "l" && groups[i].length > 2) || (kind === "m" && /^\d+(?:s|st|nd|rd|th)$/.test(groups[i])))) {
      return null;
    }
    if (!/[A-Z]/.test(token) && (kinds.includes("l") || kinds.includes("m"))) return null;
    return groups.map((group, i) => {
      const kind = kinds[i];
      if (kind === "d") return digits(group);
      if (kind === "m") return Normalizer.alnum(group);
      if (group.length > 3 && this.isWord(group.toLowerCase())) return group;
      return group.length <= 5 ? spelled(group) : group;
    }).join(" , ");
  }

  code(match) {
    const said = this.codeWords(match.group(2).split("-"), match);
    if (said === null) return match.group(0);
    return (match.group(1) ? " number " : " ") + said + " ";
  }

  grouped(match) {
    const text = match.string;
    const plus = match.group(1);
    let lead = match.group(2), trail = match.group(4);
    const core = (match.group(3) ?? match.group(5)).split(" ");
    let head = "", tail = "";
    if (lead && CAPITAL_WORDS.has(lead)) {
      head = lead + " ";
      tail = trail ? " " + trail : "";
      lead = undefined;
      trail = undefined;
    }
    const kind = identifier(text, match.start);
    const pure = core.every(isDigits);
    if (pure && !plus && !lead) {
      const following = text.slice(match.end);
      const amount = this.counted(text, match.end) ||
        new RegExp(String.raw`^\s?(?:${this.unitNames})(?![A-Za-z])`, "i").test(following);
      if (kind === null && core[0][0] !== "0" && core[0].length <= 3 && core.slice(1).every((part) => part.length === 3) &&
          (core[core.length - 1] === "000" || (amount && core.length > 2))) {
        return head + core.join(",") + tail;
      }
      if (!(kind || (core[0].length > 1 && core[0][0] === "0") || (core.length > 2 && core.some((part) => part.length > 2)))) {
        return match.group(0);
      }
    } else if (!pure && !lead && !plus && kind === null) {
      return match.group(0);
    }
    const zero = plus || kind === "phone" || (pure && core[0][0] === "0" && core.reduce((n, part) => n + part.length, 0) >= 10)
      ? "oh" : "zero";
    let spoken = pure ? Normalizer.digitGroups(core, zero)
      : core.map((part) => (isDigits(part) ? digits(part, zero) : Normalizer.alnum(part, zero))).join(" , ");
    if (lead) spoken = `${spelled(lead)} , ${spoken}`;
    if (trail) spoken = `${spoken} , ${spelled(trail)}`;
    return head + (plus ? " plus " : " ") + spoken + " " + tail;
  }

  glued(match) {
    const out = (match.group(0).match(/[A-Za-z]+|\d+/g) ?? []).map((run) => {
      if (isDigits(run)) return shortNumber(run) ? cardinal(int(run)) : digits(run);
      if (run.length === 1 || ((isUpper(run) || run.length <= 3) && !this.readsAsWord(run))) return spelled(run);
      return run;
    });
    return " " + out.join(" ") + " ";
  }

  addressPart(part) {
    const lower = part.toLowerCase();
    if (part.length > 1 && this.isWord(lower) && (part.length > 2 || SHORT_WORDS.has(lower))) return part;
    return part.length <= 3 ? spelled(part) : part;
  }

  spokenAddress(core) {
    const pieces = core.match(/[A-Za-z]+|\d+|./gs) ?? [];
    const mail = core.includes("@");
    let host = false;
    const out = [];
    pieces.forEach((piece, index) => {
      const following = pieces[index + 1] ?? "";
      if (piece === "@") host = true;
      if (isDigits(piece)) out.push(addressDigits(piece));
      else if (!isAlpha(piece)) out.push(SEPARATORS[piece] ?? "");
      else if (index && pieces[index - 1] === "." && (host || !mail) &&
               (["", "/", ":", "?", "#"].includes(following) ||
                (piece.length <= 3 && (piece.toLowerCase() in ENDINGS || !this.isWord(piece.toLowerCase()))))) {
        out.push(ENDINGS[piece.toLowerCase()] === "word" ? piece.toLowerCase() : spelled(piece));
      } else {
        let letters = "";
        for (const part of piece.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []) {
          const spoken = this.addressPart(part);
          if (spoken.startsWith(SPELL)) { letters += part; continue; }
          if (letters) { out.push(spelled(letters)); letters = ""; }
          out.push(spoken);
        }
        if (letters) out.push(spelled(letters));
      }
    });
    return out.filter(Boolean).join(" ");
  }

  address(match) {
    const whole = match.group(0);
    const text = whole.replace(/[.,;:!?)]+$/, "");
    const tail = whole.slice(text.length);
    if (match.groups.file) {
      const ending = match.groups.ending;
      const known = ending.toLowerCase() in ENDINGS;
      const marked = Boolean(match.groups.folder || match.groups.path) || match.groups.stem.includes("_");
      if (!(known || (marked && ending.length <= 5 && (ending === ending.toLowerCase() || isUpper(ending)) &&
                      !this.isWord(ending.toLowerCase())))) {
        return whole;
      }
    }
    const core = text.replace(/^(?:https?:\/\/)?(?:www\.)?/, "").replace(/\/+$/, "");
    return ` ${this.spokenAddress(core)} ${tail}`;
  }

  chatForm(match) {
    const said = CHAT[match.group(0).toLowerCase()];
    if (said === undefined) return match.group(0);
    if (said === "-") return " ";
    return " " + said.split(" ").map((part) => (part.startsWith("*") ? spelled(part.slice(1)) : part)).join(" ") + " ";
  }

  dotted(match) {
    const letters = match.group(0).replace(/\./g, "");
    const key = letters.toLowerCase();
    const following = match.string.slice(match.end).trimStart();
    const said = key === "eg" ? "for example" : key === "ie" ? "that is" : spelled(letters.toUpperCase());
    const first = following.match(/^[A-Za-z']+/);
    const endsSentence = !following || (isUpper(following[0]) && first && SENTENCE_STARTERS.has(first[0].toLowerCase()));
    return ` ${said}${endsSentence && match.group(0).endsWith(".") ? " ." : ""} `;
  }

  abbreviation(match) {
    const text = match.string, token = match.group(1), stop = match.group(2);
    const key = token.toLowerCase();
    const following = text.slice(match.end);
    const nextWord = following.match(/^\s*([A-Za-z]+|\d)/);
    const capitalNext = Boolean(nextWord) && isUpper(nextWord[1][0]);
    const capitalBefore = /[A-Z][a-z]+\s+$/.test(text.slice(0, match.start));
    if ((key === "st" || key === "dr") && isUpper(token[0])) {
      if (capitalNext && (stop || key === "dr")) return key === "st" ? " saint " : " doctor ";
      if (capitalBefore && stop) return (key === "st" ? " street" : " drive") + (!following.trim() ? " ." : " ");
      return match.group(0);
    }
    if (!(key in ABBREVIATIONS)) return match.group(0);
    let [when, said] = ABBREVIATIONS[key];
    const numberNext = Boolean(nextWord) && isDigits(nextWord[1]);
    if (when === "title") {
      if (!(isUpper(token[0]) && (capitalNext || stop))) return match.group(0);
    } else if (when === "number") {
      const previous = text.slice(0, match.start).match(/([A-Za-z]+)\.?\s+$/);
      if (!(stop && (numberNext || (key === "no" && previous && NUMBERED.has(previous[1].toLowerCase()))))) return match.group(0);
    } else if (!stop || (when === "small" && isUpper(token))) {
      return match.group(0);
    } else if (["mar", "sun", "sat", "jan", "dec", "max", "min", "est", "no"].includes(key) && !isUpper(token[0]) && !numberNext) {
      if (!(["max", "min", "est"].includes(key) && nextWord && nextWord[1][0] === nextWord[1][0].toLowerCase() &&
            nextWord[1][0] !== nextWord[1][0].toUpperCase())) {
        return match.group(0);
      }
    }
    if (key === "est" && !numberNext) said = "estimated";
    const endsSentence = when !== "title" && (!following.trim() || (capitalNext && SENTENCE_STARTERS.has(nextWord[1].toLowerCase())));
    return ` ${said}${endsSentence ? " ." : ""} `;
  }

  /** dizione's Normalizer.rewrite: the text with every non-word written out, letters to name between SPELL and END. */
  rewrite(text) {
    text = sub(VULGAR, text, (m) => this.vulgar(m));
    text = sub(this.area, text, (m) => this.square(m));
    text = text.replace(/²/g, " squared ").replace(/³/g, " cubed ");
    text = text.normalize("NFKC").replace(/⁄/g, "/").replace(/−/g, " minus ");
    text = text.replace(/(?<=\d)–(?=\d)/g, "-");
    text = sub(DAY_RANGE, text, (m) => this.dayRange(m));
    for (const [old, replacement] of [["‘", "'"], ["’", "'"], ["‚", "'"], ["‛", "'"], ["`", "'"], ["´", "'"], ["“", '"'], ["”", '"'],
      ["„", '"'], ["‟", '"'], ["«", '"'], ["»", '"'], ["–", "—"], ["―", "—"], ["[", "("], ["]", ")"], ["{", "("], ["}", ")"]]) {
      text = text.split(old).join(replacement);
    }
    text = sub(ADDRESS, text, (m) => this.address(m));
    text = text.replace(/→/g, " to ");
    text = text.replace(EMOJI, " ").replace(EMOTICON, " ");
    text = text.replace(/\.{3,}/g, "…");
    text = text.replace(/(?<=\d)\s-\s(?=\d[\d.,]*\s?=)/g, " minus ");
    text = text.replace(/-{2,}|\s-\s/g, "—");
    text = text.replace(/\bw\/o\b/gi, " without ").replace(/\bw\/(?=\s|$)/gi, " with ").replace(/\bn\/a\b/gi, " not applicable ");
    text = text.split("'n'").join(" 'n ");
    if (/\d/.test(text)) text = this.figures(text);
    return this.signs(text);
  }

  figures(text) {
    text = sub(MONEY, text, (m) => this.money(m));
    text = sub(MONEY_AFTER, text, (m) => this.money(m));
    text = text.replace(/(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?¢/g, (_, n) => ` ${numberWords(n)} ${n === "1" ? "cent" : "cents"} `);

    const clock = String.raw`\d{1,2}:[0-5]\d(?:\s?[AaPp]\.?[Mm]\.?)?|\b\d{1,2}\s?[AaPp]\.?[Mm]\.?`;
    text = text.replace(new RegExp(`(${clock})\\s(${ZONES})\\b`, "g"), (_, time, zone) => `${time} ${spelled(zone)}`);
    text = text.replace(/(?<![\d.,:])(\d{1,2})\.([0-5]\d)(?=\s?[AaPp]\.?[Mm]\b)/g, "$1:$2");
    text = sub(/(?<![\d.,:])(\d{1,2})\.(00|15|30|45)(\s?(?:to|until|till|and|[-—])\s?)(\d{1,2})\.(00|15|30|45)(?!\d|\.\d)/g, text,
      (m) => this.dotTimes(m));
    text = text.replace(new RegExp(String.raw`(${clock})\s?[-—]\s?(?=\d{1,2}(?::[0-5]\d|\s?[AaPp]\.?[Mm]\b))`, "g"), "$1 to ");
    text = sub(RATIO, text, (m) => this.ratio(m));
    text = sub(new RegExp(String.raw`(?<![\d:])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?${HALF_DAY}?(?![\d:])`, "g"), text, (m) => this.time(m));
    text = sub(new RegExp(String.raw`(?<![\d.:,])(\d{1,2})${HALF_DAY}(?![A-Za-z])`, "g"), text,
      (m) => ` ${cardinal(int(m.group(1)))} ` + Normalizer.halfDay(m, m.group(2), m.group(3)));

    const seen = [...text.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(?:\d{4}|\d{2}))?(?![\d/])/g)]
      .map((m) => [int(m[1]), int(m[2])]).filter(([a, b]) => !(a === 24 && b === 7));
    this.dayFirst = seen.some(([a, b]) => a > 12 && 12 >= b) && !seen.some(([a, b]) => b > 12 && 12 >= a);
    this.dated = /(?<![\d/])\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})(?![\d/])/.test(text);
    text = sub(/(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g, text,
      (m) => this.date(int(m.group(2)), int(m.group(3)), m.group(1)) ?? m.group(0));
    text = sub(/(?<![\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g, text,
      (m) => this.date(int(m.group(2)), int(m.group(3)), m.group(1)) ?? m.group(0));
    text = sub(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d|\.\d)/g, text, (m) => this.dotDate(m));
    text = sub(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g, text, (m) => this.slashDate(m));
    text = sub(new RegExp(String.raw`\b(${MONTH_PATTERN})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s?[-—]\s?(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\d:])`, "g"),
      text, (m) => this.daysOfMonth(m));
    text = sub(new RegExp(String.raw`(?<![\d.,/:-])(\d{1,2})(?:st|nd|rd|th)?\s?[-—]\s?(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})\b(?:,?\s+(\d{4}))?`, "g"),
      text, (m) => this.daysOfMonth(m));
    text = sub(new RegExp(String.raw`\b(${MONTH_PATTERN})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\d:])`, "g"), text,
      (m) => this.date(MONTH_NUMBER[m.group(1).toLowerCase().slice(0, 3)], int(m.group(2)), m.group(3)) ?? m.group(0));
    text = sub(new RegExp(String.raw`(?<![\d.,/:-])(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})\b(\.(?=\s+[a-z\d]))?(?:,?\s+(\d{4}))?`, "g"),
      text, (m) => this.dayMonth(m));

    text = sub(/(?<![\d-])(?:\+?(1)[-.\s])?\(?(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})(?![\d-])/g, text, (m) => this.phone(m));
    text = sub(/(?<![\w.,-])(\d{3})-(\d{4})(?![\w-])/g, text, (m) => this.phone(m));
    text = sub(/(?<![\w.])([vV])?(\d+(?:\.\d+){2,})(?:-(\d+)(?![\w-]|\.\d))?(?!\w)/g, text,
      (m) => " " + (m.group(1) ? spelled(m.group(1)) + " " : "") + m.group(2).split(".").map(versionPart).join(" point ") +
        (m.group(3) ? " dash " + numberWords(m.group(3)) : "") + " ");
    text = sub(/(?<![\w.])([vV])(\d+)\.(\d{2,3})(?!\d|\.\d|\w)/g, text,
      (m) => ` ${spelled(m.group(1))} ${cardinal(int(m.group(2)))} point ${minor(m.group(3))} `);
    text = sub(new RegExp(String.raw`\b(${VERSIONED})(\.?\s(?:(?:from|to)\s)?)(\d+)\.(\d{2,3})(?:(\s(?:to|or|and)\s)(\d+)\.(\d{2,3}))?(?!\d|\.\d|\s?%|\s(?:percent|million|billion)\b)`, "gi"),
      text, (m) => `${m.group(1)}${m.group(2)}${cardinal(int(m.group(3)))} point ${minor(m.group(4))}` +
        (m.group(5) ? `${m.group(5)}${cardinal(int(m.group(6)))} point ${minor(m.group(7))}` : "") + " ");
    text = sub(CODE, text, (m) => this.code(m));
    text = sub(SLASHED, text, (m) => " " + Normalizer.digitGroups(m.group(1).split("/")) + " ");
    text = sub(GROUPED, text, (m) => this.grouped(m));

    text = text.replace(/(?<![\w.])-(?=\d)/g, " minus ");
    text = text.replace(new RegExp(String.raw`(?:(?<=\d)\s?[xX×]|×)\s?(?=\d[\d.,]*\s?(?:${LENGTHS})\b)`, "g"), " by ");
    text = text.replace(/(?<=\d)\s[xX×]\s(?=\d)/g, " times ");
    text = sub(/(?<![\w/'])[A-Za-z0-9/]*[0-9/][A-Za-z0-9/]*(?![\w/'])/g, text, (m) => this.chatForm(m));
    text = text.replace(/(?<![\w.])'?(\d{2}|\d{4})'?s\b/g, (_, n) => " " + pluralOf(n.length === 4 ? year(int(n)) : cardinal(int(n))) + " ");
    text = text.replace(/(?<![\w.])(\d+)(?:st|nd|rd|th)\b/g, (_, n) => ` ${ordinal(int(n))} `);
    text = text.replace(/(?<![\w.])(144|240|360|480|540|576|720|900|1080|1440|2160|4320)([pi])\b/g,
      (_, n, letter) => ` ${pairs(int(n))} ${spelled(letter)} `);
    text = text.replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, n) => ` ${numberWords(n)} percent `);
    text = sub(this.areaPlain, text, (m) => this.square(m));
    text = sub(this.unit, text, (m) => this.measure(m));
    text = sub(/(?<![\d/.,-])(\d+) (\d)\/(2|3|4|5|6|8|10|16)(?![\d/]|\.\d)/g, text, (m) => this.mixedFraction(m));
    text = sub(/(?<![\d/.])(\d+)\/(\d+)(?![\d/]|\.\d)/g, text, (m) => this.fraction(m));
    text = text.replace(/(?<![\w.,-])(\d{4})[-–](\d{4})(?![\w.,-])/g, (_, a, b) => ` ${year(int(a))} to ${year(int(b))} `);
    text = text.replace(/(?<![\w.,-])(\d+)[-–](\d+)(?![\w-]|[.,]\d)/g, (_, a, b) => ` ${numberWords(a)} to ${numberWords(b)} `);
    text = text.replace(/(?<![\w.])(\d+)x\b/g, (_, n) => ` ${numberWords(n)} times `);
    text = text.replace(/(?<=\d)\^(?=\d)/g, " to the power of ");
    return text;
  }

  signs(text) {
    text = text.replace(new RegExp(String.raw`(?<![\w-])(${SIZES})-(${SIZES})(?![\w-])`, "g"), (_, a, b) => ` ${spelled(a)} to ${spelled(b)} `);
    text = text.replace(/#(?=\d)/g, " number ").replace(/#(?=[A-Z]{1,4}-?\d)/g, " number ").replace(/#(?=[A-Za-z])/g, " hashtag ");
    text = text.replace(/~(?=\s?\d)/g, " about ");
    text = text.replace(/(?<=[\w\s])(>=|<=|!=)(?=[\w\s])/g, (_, sign) => ` ${COMPARISONS[sign]} `);
    text = text.replace(/(?<=\d) Ti\b/g, ` ${spelled("TI")}`);
    text = text.replace(/\b([Rr])ef\.\s?[Nn]o\.(?=\s)/g, "$1eference number");
    if (text.includes(".")) text = sub(/\b((?:[A-Za-z]\.){2,})/g, text, (m) => this.dotted(m));
    text = sub(/\b([A-Za-z]{1,6})\b(\.?)(?![A-Za-z'’])/g, text, (m) => this.abbreviation(m));
    if (/\d/.test(text)) {
      text = sub(GLUED, text, (m) => this.glued(m));
      text = sub(/(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<![\w.])\.\d+/g, text, (m) => this.number(m));
    }
    text = text.replace(/(?<=[A-Za-z])\/(?=[A-Za-z])/g, " ");
    text = text.replace(/(?<=\d)\s?[<>]\s?(?=\d)|(?<=\s)[<>](?=\s)/g, (sign) => (sign.includes("<") ? " less than " : " greater than "));
    text = text.replace(new RegExp(`[${escape(Object.keys(SYMBOL_WORDS).join(""))}]`, "g"), (sign) => ` ${SYMBOL_WORDS[sign]} `);
    return text;
  }
}

/**
 * Text as a voice should read it. `spell(letters)` writes a run of letters to be named the way the voice's
 * phonemizer names letters ("A-M" for eSpeak, "AM" for Kale's).
 */
export function spokenText(text, normalizer, spell) {
  return normalizer
    .rewrite(text)
    .replace(new RegExp(`${SPELL}([A-Za-z ]+)${END}`, "g"), (_, letters) => ` ${spell(letters.replace(/ /g, ""))} `)
    .replace(/\s+/g, " ")
    .replace(/ (?=[,.;:!?…])/g, "")
    .replace(/([,.;:!?…])(?=[,.;:!?…])/g, (mark, _, at, all) => (mark === all[at + 1] ? "" : mark))
    .trim();
}
