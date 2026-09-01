import type { PdfPage } from '../../src/kernel/pdf.ts';

// A lease the golden set can index, and the reason it is written by hand.
//
// The only real lease this project has must never enter the repo
// (tasks/fuses.md, fuse 3), and src/kernel/pdf-sample.ts is Latin-text-only by
// design -- carrying Hebrew through pdfjs needs an embedded font and a CMap,
// and the defect this fixture exists to reproduce is *about* Hebrew semantic
// similarity. So the fixture is authored one layer above pdfjs, as the
// `PdfPage[]` the kernel adapter produces, and everything downstream of that is
// the real thing: chunkLease, the real embedder, real pgvector, searchClauses.
//
// **Reproducing the defect is this fixture's acceptance bar.** Slice 12.2
// measured retrieval on the real lease and found it unordered: both of the
// owner's questions returned the right clause outside the top two, the same two
// chunks won both questions on unrelated topics, and every distance in both
// result sets fell between 0.35 and 0.51 -- relevant and irrelevant alike. A
// fixture that ranks cleanly would measure nothing, so this one is built to
// carry the suspected cause rather than to be a tidy document.
//
// The structure follows docs/reference/lease-template-donadom.md: boilerplate
// body, facts in the annexes, נספח א׳ naming its clauses in words. Values are
// invented. No real person, ID number, phone, email or address appears here.

// Enough readable text for a page to be a page (clauses.ts, minPageChars).
const filler =
  'הצדדים מצהירים כי קראו את ההסכם, הבינו את תוכנו ואת מלוא התחייבויותיהם על פיו.';

// One right-aligned Hebrew line per entry, in the top-down coordinates the
// kernel adapter produces. Same shape src/occupancy/contract.test.ts builds.
function page(number: number, lines: string[]): PdfPage {
  return {
    number,
    width: 595,
    height: 842,
    items: [...lines, filler].map((text, index) => ({
      text,
      x: 150,
      y: 60 + index * 20,
      width: 340,
      height: 11,
      rightToLeft: true,
      endsLine: true,
    })),
  };
}

// The other shape נספח א׳ comes in, and the reason this fixture grew one in
// slice 14.1d: a two-column label/value table whose **corridor is 11 points**.
//
// Every fixture in this repo had a wide corridor -- 40pt in the chunker's own
// unit test -- which is why 14.1b's width-based split passed everything here and
// then failed on the contract, where the corridor is 11.0pt and 17 of every 100
// ordinary word gaps on the same page are wider than that. The rows below also
// carry the braid the way the real annex carries it: the label cell's lines and
// the value cell's lines fall on *different* baselines, so read line by line
// they interleave as [label 1] [value 1] [label 2] [value 2].
//
// Geometry, so it can be checked against the measurement rather than trusted:
// values end at x=294 and labels start at x=305, a corridor of 11pt; each column
// is ~225pt wide, well past a numbering margin's 14.
function tablePage(
  number: number,
  title: string,
  rows: { label: string[]; value: string[] }[],
  closing: string,
): PdfPage {
  const items = [];
  const spanning = (text: string, y: number) => ({
    text,
    x: 70,
    y,
    width: 460,
    height: 11,
    rightToLeft: true,
    endsLine: true,
  });
  items.push(spanning(title, 40));
  let y = 90;
  for (const row of rows) {
    row.label.forEach((text, index) =>
      items.push({
        text,
        x: 305,
        y: y + index * 16,
        width: 225,
        height: 11,
        rightToLeft: true,
        endsLine: true,
      }),
    );
    // Eight points below its label's line, which is more than a baseline
    // tolerance and less than a line: the offset that produces the braid.
    row.value.forEach((text, index) =>
      items.push({
        text,
        x: 70,
        y: y + 8 + index * 16,
        width: 224,
        height: 11,
        rightToLeft: true,
        endsLine: true,
      }),
    );
    y += 16 * Math.max(row.label.length, row.value.length) + 34;
  }
  items.push(spanning(closing, y));
  return { number, width: 595, height: 842, items };
}

// The attractor, and the whole point of page 1.
//
// Parties, ID numbers, a phone, an email, two addresses, a parcel and a tender
// number -- fifteen lines that are *about* nothing in particular and mention
// everything. 12.2's hypothesis is that a chunk like this embeds near the
// centre of the space and therefore sits close to every question asked of the
// document. It carries no clause number and no annex heading, so chunkLease
// gives it `clauseRef: null` and a citation cannot name it, which is the second
// half of why it matters: it is the PII-densest text in the lease and the most
// likely thing retrieved for a vague question.
const frontPage = [
  'הסכם שכירות למגורים',
  'שנערך ונחתם בתל אביב ביום 12 בפברואר 2026',
  'בין: חברת דיור להשכרה בע״מ, ח.פ. 515248871, מרחוב הנשיא 8, חיפה',
  'שכתובתה למסירת הודעות היא ת.ד. 4471, חיפה, מיקוד 3100202 (להלן: "המשכיר")',
  'לבין: ישראל ישראלי, ת.ז. 039284715, מרחוב ביאליק 12א, רמת גן',
  'ורעייתו שרה ישראלי, ת.ז. 027481930, טלפון 050-1234567',
  'דואר אלקטרוני israel.israeli@example.co.il (להלן: "השוכר")',
  'הדירה: דירה מס׳ 24, קומה 2, בבניין ברחוב ארלוזורוב 45, תל אביב',
  'הידועה כחלקה 118 בגוש 6213, תת-חלקה 24',
  'המתחם נבנה במסגרת מכרז רשות מקרקעי ישראל מספר מר/347/2021',
  'ובפיקוח משרד הבינוי והשיכון, אגף דיור להשכרה',
  'הואיל והמשכיר הוא בעל זכויות החכירה במקרקעין',
  'והואיל והשוכר מעוניין לשכור את הדירה בהתאם לתנאי המכרז',
  'והואיל והשוכר הצהיר כי הוא עומד בתנאי הזכאות שנקבעו במכרז',
  'לפיכך הוצהר, הותנה והוסכם בין הצדדים כדלקמן',
];

// The body: twenty clauses of boilerplate, of which these are the ones a
// question might plausibly land on by accident. Numbered in digits, the form
// the body uses.
const bodyOne = [
  '1. מבוא, נספחים והגדרות',
  '1.1 המבוא להסכם זה והנספחים המצורפים לו מהווים חלק בלתי נפרד הימנו.',
  '1.2 כותרות הסעיפים נועדו לנוחות הקריאה בלבד ולא ישמשו לפרשנות ההסכם.',
  '1.3 "הדירה" - הדירה המתוארת בנספח א׳ על כל המחובר אליה חיבור של קבע.',
  '2. הצהרות השוכר',
  '2.1 השוכר מצהיר כי ראה ובדק את הדירה ומצאה מתאימה לצרכיו.',
  '2.2 השוכר מצהיר כי הוא עומד בתנאי הזכאות ומתחייב להודיע על כל שינוי בהם.',
  '2.3 השוכר מצהיר כי ידוע לו שחוק הגנת הדייר אינו חל על הסכם זה.',
];

const bodyTwo = [
  '5. תקופת השכירות',
  '5.1 תקופת השכירות, תנאי הארכתה והמועדים הנוגעים לה קבועים בנספח א׳.',
  '5.2 אין בהוראות סעיף זה כדי לגרוע מזכות המשכיר לפי סעיף 12 להלן.',
  '6. מסירת הדירה',
  '6.1 הדירה תימסר לשוכר במועד המסירה כשהיא פנויה מכל אדם וחפץ.',
  '6.2 במעמד המסירה ייערך פרוטוקול מסירה שייחתם בידי שני הצדדים.',
];

const bodyThree = [
  '7. תיקונים, אחזקה ובלאי',
  '7.1 המשכיר יתקן על חשבונו ליקויים הנובעים מבלאי סביר ומפגמים מובנים בדירה.',
  '7.2 השוכר יישא בעלות תיקון נזק שנגרם בשל שימוש בלתי סביר או בשל רשלנות.',
  '7.3 השוכר יודיע למשכיר על כל ליקוי הטעון תיקון בסמוך לאחר שנודע לו עליו.',
  '7.4 המשכיר יהיה רשאי להיכנס לדירה לצורך ביצוע תיקון לאחר תיאום מראש.',
];

const bodyFour = [
  '12. הפרות, ביטול ותרופות',
  '12.1 הפרה יסודית של הסכם זה מזכה את הצד הנפגע בביטולו לאלתר.',
  '12.2 איחור בתשלום העולה על שלושים ימים ייחשב הפרה יסודית של ההסכם.',
  '20. הודעות',
  '20.1 הודעה שתישלח בדואר רשום תיחשב כאילו הגיעה לנמען בתום שלושה ימי עסקים.',
  '20.2 כתובות הצדדים למסירת הודעות הן הכתובות המפורטות במבוא להסכם זה.',
];

// נספח א׳ -- the annex the twin reads, and where both golden questions are
// answered. It names the body clause each row qualifies in words rather than
// leading with a digit (`סעיף 5 – ...`), which is the form 12.1 cost two
// commits to learn.
// Laid out as the real annex is (`tablePage`): two columns, an 11pt corridor,
// and cells that wrap onto different baselines. The words are the ones this
// page always carried, so the golden question about the term is asked of the
// same sentences -- what changed is the geometry they arrive in.
const annexAOne: { label: string[]; value: string[] }[] = [
  {
    label: ['סעיף 5 – תקופת השכירות'],
    value: [
      'תקופת השכירות הראשונה היא 36 חודשים, מיום 1 במרץ 2026',
      'ועד יום 28 בפברואר 2029.',
    ],
  },
  {
    label: ['תקופות הארכה, מימושן', 'וההודעה עליהן'],
    value: [
      'לשוכר עומדות שתי אופציות הארכה, בנות 24 חודשים כל אחת,',
      'בתנאים הקבועים בהסכם. הודעה על מימוש אופציה תימסר',
      'למשכיר לא יאוחר מתשעים ימים לפני תום התקופה.',
    ],
  },
  {
    label: ['סך כל תקופות השכירות'],
    value: ['ובלבד שסך כל תקופות השכירות יחדיו לא יעלה על עשר שנים ממועד המסירה.'],
  },
];

const annexATwo = [
  'סעיף 10 – דמי השכירות ודמי הניהול',
  'דמי השכירות החודשיים בבסיס הם 4,850 ש"ח, וישולמו מדי חודש בחודשו ביום ה-1.',
  'דמי השכירות צמודים למדד המחירים לצרכן, כאשר מדד הבסיס הוא מדד חודש ינואר 2026.',
  'עדכון דמי השכירות ייערך אחת לשנים עשר חודשים בהתאם לשיעור עליית המדד.',
  'דמי הניהול החודשיים הם 310 ש"ח, והם אינם חלק מדמי השכירות ואינם צמודים למדד.',
  'סעיף 12 – בטוחות',
  'להבטחת התחייבויות השוכר תופקד ערבות בנקאית אוטונומית בסך 14,550 ש"ח.',
  'לחלופין רשאי השוכר להפקיד פיקדון במזומן בסכום זהה, לפי בחירתו.',
];

// נספח ב׳ -- house rules. Not a golden case in this slice, and here because a
// document with only two annexes is not the document being modelled: an
// unrelated topic in the same lease is part of what makes ranking a question at
// all.
const annexB = [
  'נספח ב׳ — תקנון המתחם',
  '1. שעות המנוחה במתחם הן בין 14:00 ל-16:00 ובין 22:00 ל-07:00.',
  '2. אין להפעיל מכשירי חשמל רועשים ואין לבצע עבודות שיפוץ בשעות המנוחה.',
  '3. החזקת בעלי חיים בדירה טעונה אישור מראש ובכתב מהנהלת המתחם.',
  '4. אין להבעיר אש או להשתמש בגריל על המרפסות ובשטחים המשותפים.',
  '5. השימוש בחדר הכושר ובחדר הדיירים הוא לדיירי המתחם בלבד.',
];

/** The mock lease, as the kernel's PDF adapter would hand it over. */
export const mockLeasePages: PdfPage[] = [
  page(1, frontPage),
  page(2, bodyOne),
  page(3, bodyTwo),
  page(4, bodyThree),
  page(5, bodyFour),
  tablePage(6, 'נספח א׳ — פרטי העסקה', annexAOne, filler),
  page(7, annexATwo),
  page(8, annexB),
];

// What a citation must name for each golden question, so the case files and the
// measurement agree on one spelling of a clause reference.
export const mockLeaseRefs = {
  term: 'נספח א׳ §5',
  rent: 'נספח א׳ §10',
  securities: 'נספח א׳ §12',
  // The chunker decides how a reference is spelled, not the author of a case:
  // clause 7 comes back as a merged range because 7.1-7.3 are short. A case
  // naming '§7' fails with "did not come back at all", which is the grader
  // working rather than the corpus failing.
  repairs: '§7.1–7.3',
} as const;
