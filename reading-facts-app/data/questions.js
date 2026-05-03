// ============================================================
// READING ATOMS — the K-5 phonics + sight word + blending pool.
//
// This file is built on the Phase 1 pedagogy framework (Science of
// Reading + Scarborough's Rope + Ehri's phases). Each ATOM represents
// one learnable unit per the framework's atomic decomposition:
//
//   • GPC atoms (grapheme→phoneme): single consonants, short vowels,
//     silent-e, digraphs, blends, vowel teams, r-controlled, etc.
//   • Sight-word atoms (orthographic-mapping): the most frequent
//     irregular words children must recognize on sight.
//   • Blending atoms: CVC and CCVC decoding practice.
//   • Speaking atoms: oral production with speech recognition.
//
// EVERY atom carries:
//   id, type, category, difficulty, prompt, answer, choices, sound,
//   targetLatencyMs  ← the latency below which an atom counts as
//                       MASTERED (per Phase 1 §1.2: GPC must hit
//                       sub-second retrieval; sight words sub-500ms).
//
// Helper builders below (letterSound, sightWord, etc.) generate
// atoms compactly so we can cover ~150 items without 1500 lines of
// repetitive object literals. Add atoms by extending the input
// arrays at the bottom — the helpers do the rest.
// ============================================================

// Per-atom-type latency targets (ms). Phase 1 §1.2 specifies <1.0s
// for GPC. We're slightly more lenient for first exposure and tighten
// further for sight words (Ehri's orthographic mapping bound).
const TARGET_LATENCY = {
  "letter-sound":  1500,
  "digraph":       1800,
  "blend":         2000,
  "silent-e":      2000,
  "vowel-team":    2000,
  "r-controlled":  2000,
  "soft":          2000,
  "advanced":      2500,
  "sight-word":     900,  // orthographic mapping: should feel automatic
  "blending":      3000,  // multi-step: see graphemes → blend → recognize
  "speak":         4000,  // includes record-then-recognize delay
  // Phonemic awareness (PA) atoms — pre-print, audio-first.
  "pa-blend":      4000,  // hear separated phonemes → blend → say/pick word
  "pa-initial":    3000,  // hear word → identify first sound
  "pa-final":      3000,  // hear word → identify last sound
  "pa-substitute": 5000,  // hear word + swap instruction → produce new word
  "vocab-tier2":   4000,  // see word → pick definition
  "picture-word":  3000,  // see picture (emoji) → say/pick the word
};

// Pick `n` random items from `arr`, excluding any in `exclude` set.
function pickRandom(arr, n, exclude = new Set()) {
  const pool = arr.filter((x) => !exclude.has(x));
  const out = [];
  while (out.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// Shuffle in place + return.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================================
// SOURCE DATA — letter / sound / example word triples
// ============================================================

// Single consonants (21) — letter, "stretched/spoken" form, example word.
const SINGLE_CONSONANTS = [
  ["b", "buh",  "bat"],
  ["c", "kuh",  "cat"],
  ["d", "duh",  "dog"],
  ["f", "ffff", "fish"],
  ["g", "guh",  "goat"],
  ["h", "huh",  "hat"],
  ["j", "juh",  "jam"],
  ["k", "kuh",  "kite"],
  ["l", "llll", "lion"],
  ["m", "mmmm", "mom"],
  ["n", "nnnn", "nest"],
  ["p", "puh",  "pig"],
  ["q", "kwuh", "queen"],
  ["r", "rrrr", "run"],
  ["s", "ssss", "sun"],
  ["t", "tuh",  "top"],
  ["v", "vvvv", "van"],
  ["w", "wuh",  "win"],
  ["x", "ks",   "box"],
  ["y", "yuh",  "yes"],
  ["z", "zzzz", "zoo"],
];

// Short vowels (5).
const SHORT_VOWELS = [
  ["a", "ahh", "apple"],
  ["e", "eh",  "egg"],
  ["i", "ih",  "igloo"],
  ["o", "ahh", "octopus"], // short o is /ɑ/
  ["u", "uh",  "up"],
];

// Long vowels (silent-e). prompt shows the pattern e.g. "a_e".
const SILENT_E = [
  ["a_e", "ay",  "make"],
  ["i_e", "eye", "bike"],
  ["o_e", "oh",  "hope"],
  ["u_e", "yoo", "cube"],
  ["e_e", "ee",  "Pete"],
];

// Consonant digraphs (8).
const DIGRAPHS = [
  ["sh",  "shhh", "ship"],
  ["ch",  "chuh", "chip"],
  ["th",  "thuh", "thumb"],
  ["wh",  "wuh",  "whale"],
  ["ck",  "kuh",  "kick"],
  ["ng",  "nnng", "ring"],
  ["ph",  "ffff", "phone"],
  ["qu",  "kwuh", "quick"],
];

// Consonant blends (~20).
const BLENDS = [
  ["bl", "bl", "blue"],   ["br", "br", "brown"],
  ["cl", "cl", "clap"],   ["cr", "cr", "crab"],
  ["dr", "dr", "drum"],   ["fl", "fl", "flag"],
  ["fr", "fr", "frog"],   ["gl", "gl", "glad"],
  ["gr", "gr", "grass"],  ["pl", "pl", "plus"],
  ["pr", "pr", "print"],  ["sk", "sk", "skin"],
  ["sl", "sl", "slip"],   ["sm", "sm", "small"],
  ["sn", "sn", "snap"],   ["sp", "sp", "spin"],
  ["st", "st", "star"],   ["sw", "sw", "swim"],
  ["tr", "tr", "tree"],   ["str","str","string"],
];

// Vowel teams (10).
const VOWEL_TEAMS = [
  ["ai", "ay",  "rain"],
  ["ay", "ay",  "day"],
  ["ee", "ee",  "bee"],
  ["ea", "ee",  "leaf"],
  ["oa", "oh",  "boat"],
  ["ow", "oh",  "snow"],
  ["oo", "oo",  "moon"],
  ["ou", "ow",  "out"],
  ["oy", "oy",  "boy"],
  ["oi", "oy",  "coin"],
];

// R-controlled vowels (5).
const R_CONTROLLED = [
  ["ar", "ar",  "car"],
  ["er", "er",  "her"],
  ["ir", "er",  "bird"],
  ["or", "or",  "corn"],
  ["ur", "er",  "turn"],
];

// Soft c/g — letter pattern, sound, example word.
const SOFT_C_G = [
  ["ce", "suh", "ice"],
  ["ci", "suh", "city"],
  ["ge", "juh", "page"],
  ["gi", "juh", "giant"],
];

// Advanced graphemes (5).
const ADVANCED = [
  ["igh",  "eye",  "high"],
  ["tion", "shun", "action"],
  ["sion", "zhun", "vision"],
  ["augh", "aw",   "caught"],
  ["eigh", "ay",   "eight"],
];

// CVC / CCVC blending words — student sees "c – a – t" and picks the word.
const BLENDING_WORDS = [
  ["cat",  ["c", "a", "t"],   ["cap", "can"]],
  ["sun",  ["s", "u", "n"],   ["sit", "fun"]],
  ["fish", ["f", "i", "sh"],  ["fin", "wish"]],
  ["shop", ["sh", "o", "p"],  ["chop", "ship"]],
  ["map",  ["m", "a", "p"],   ["mat", "man"]],
  ["pet",  ["p", "e", "t"],   ["pen", "pat"]],
  ["hop",  ["h", "o", "p"],   ["hot", "hat"]],
  ["big",  ["b", "i", "g"],   ["bug", "bag"]],
  ["run",  ["r", "u", "n"],   ["ran", "rug"]],
  ["win",  ["w", "i", "n"],   ["wig", "won"]],
  ["chip", ["ch", "i", "p"],  ["ship", "chop"]],
  ["thin", ["th", "i", "n"],  ["tin", "then"]],
  ["star", ["s", "t", "ar"],  ["stay", "scar"]],
  ["stop", ["s", "t", "o", "p"], ["spot", "shop"]],
  ["frog", ["f", "r", "o", "g"], ["flog", "fog"]],
];

// Sight words — Fry first 50, with similar-looking distractors that
// trip students up if orthographic mapping is incomplete.
const SIGHT_WORDS = [
  ["the",   ["they", "this"]],
  ["of",    ["if", "off"]],
  ["and",   ["an", "end"]],
  ["a",     ["an", "at"]],
  ["to",    ["too", "do"]],
  ["in",    ["it", "on"]],
  ["is",    ["if", "it"]],
  ["you",   ["your", "yes"]],
  ["that",  ["than", "what"]],
  ["it",    ["if", "in"]],
  ["he",    ["her", "the"]],
  ["was",   ["way", "saw"]],
  ["for",   ["from", "four"]],
  ["on",    ["no", "in"]],
  ["are",   ["art", "ate"]],
  ["as",    ["at", "am"]],
  ["with",  ["wish", "will"]],
  ["his",   ["has", "is"]],
  ["they",  ["the", "then"]],
  ["I",     ["it", "in"]],
  ["at",    ["an", "am"]],
  ["be",    ["by", "big"]],
  ["this",  ["his", "that"]],
  ["have",  ["has", "gave"]],
  ["from",  ["for", "form"]],
  ["or",    ["on", "of"]],
  ["one",   ["on", "once"]],
  ["had",   ["has", "mad"]],
  ["by",    ["my", "be"]],
  ["word",  ["ward", "world"]],
  ["but",   ["bit", "bat"]],
  ["not",   ["no", "hot"]],
  ["what",  ["want", "that"]],
  ["all",   ["ill", "ate"]],
  ["were",  ["wear", "where"]],
  ["we",    ["me", "who"]],
  ["when",  ["then", "where"]],
  ["your",  ["you", "yours"]],
  ["can",   ["cane", "ran"]],
  ["said",  ["sad", "side"]],
  ["there", ["their", "where"]],
  ["use",   ["us", "used"]],
  ["an",    ["at", "am"]],
  ["each",  ["eat", "ear"]],
  ["which", ["witch", "where"]],
  ["she",   ["he", "see"]],
  ["do",    ["go", "to"]],
  ["how",   ["who", "now"]],
  ["their", ["there", "them"]],
  ["if",    ["it", "of"]],
];

// Note: an earlier version of this file had a separate SPEAKING_ATOMS
// section. Now that EVERY atom carries an `accepted` field for
// speech-recognition input, those duplicate entries were removed.
// The app picks input mode (mic vs choices) at render time.

// ============================================================
// HELPERS — turn source rows into atom objects
// ============================================================

// Pool of "/x/ as in word" strings, used for distractors across
// letter-sound / vowel / digraph atoms.
const ALL_PHONEME_DESCRIPTORS = [
  ...SINGLE_CONSONANTS, ...SHORT_VOWELS, ...DIGRAPHS,
].map(([letter, , word]) => `/${letter}/ as in ${word}`);

function describePhoneme(letter, word) {
  return `/${letter}/ as in ${word}`;
}

// Spoken letter names — what a student saying just the letter aloud
// would actually say. Used to seed the `accepted` ASR list so saying
// "em" for `m` counts as a valid response.
const LETTER_NAMES = {
  a: "ay",  b: "bee", c: "see", d: "dee", e: "ee",  f: "eff",
  g: "gee", h: "aitch", i: "eye", j: "jay", k: "kay", l: "ell",
  m: "em",  n: "en",  o: "oh",  p: "pee", q: "cue", r: "are",
  s: "ess", t: "tee", u: "you", v: "vee", w: "double you",
  x: "ex",  y: "why", z: "zee",
};

// Build the list of accepted speech transcriptions for an atom.
// Generous on purpose — browser ASR often returns variants ("em" for
// "m", or the example word). Anything in this list counts as correct
// when the student speaks aloud.
function deriveAccepted({ prompt, sound, exampleWord, answer }) {
  const set = new Set();
  const add = (s) => {
    if (typeof s !== "string") return;
    const t = s.toLowerCase().trim();
    if (t) set.add(t);
  };

  add(prompt);
  if (typeof prompt === "string") add(prompt.replace(/_/g, ""));   // a_e → ae
  add(sound);
  if (typeof sound === "string") add(sound.replace(/(.)\1+/g, "$1")); // mmmm → m
  add(exampleWord);

  // For "/x/ as in word" answer strings, accept the inner letter and word.
  if (typeof answer === "string") {
    const m = answer.match(/^\/([^/]+)\/\s+as in\s+(\w+)$/i);
    if (m) { add(m[1]); add(m[2]); }
    else add(answer);
  }

  // Letter name (e.g. saying "em" for prompt "m").
  if (typeof prompt === "string" && prompt.length === 1) {
    add(LETTER_NAMES[prompt.toLowerCase()]);
  }

  return Array.from(set);
}

function makePhonemeAtom({ id, type, category, difficulty, letter, sound, exampleWord }) {
  const correct = describePhoneme(letter, exampleWord);
  const distractors = pickRandom(ALL_PHONEME_DESCRIPTORS, 2, new Set([correct]));
  return {
    id,
    type,
    category,
    difficulty,
    prompt: letter,
    sound,
    answer: correct,
    choices: shuffle([correct, ...distractors]),
    accepted: deriveAccepted({ prompt: letter, sound, exampleWord, answer: correct }),
    targetLatencyMs: TARGET_LATENCY[type] ?? 2000,
  };
}

function letterSound([letter, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.cons.${letter}`,
    type: "letter-sound",
    category: "Letter sounds",
    difficulty: 1,
    letter, sound, exampleWord: word,
  });
}

function shortVowel([letter, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.short.${letter}`,
    type: "letter-sound",
    category: "Letter sounds",
    difficulty: 1,
    letter, sound, exampleWord: word,
  });
}

function silentEAtom([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.silent.${pattern}`,
    type: "silent-e",
    category: "Silent-e",
    difficulty: 2,
    letter: pattern, sound, exampleWord: word,
  });
}

function digraph([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.digraph.${pattern}`,
    type: "digraph",
    category: "Digraphs",
    difficulty: 2,
    letter: pattern, sound, exampleWord: word,
  });
}

function blend([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.blend.${pattern}`,
    type: "blend",
    category: "Blends",
    difficulty: 2,
    letter: pattern, sound, exampleWord: word,
  });
}

function vowelTeam([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.team.${pattern}`,
    type: "vowel-team",
    category: "Vowel teams",
    difficulty: 3,
    letter: pattern, sound, exampleWord: word,
  });
}

function rControlled([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.r.${pattern}`,
    type: "r-controlled",
    category: "R-controlled",
    difficulty: 3,
    letter: pattern, sound, exampleWord: word,
  });
}

function softCG([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.soft.${pattern}`,
    type: "soft",
    category: "Soft c/g",
    difficulty: 3,
    letter: pattern, sound, exampleWord: word,
  });
}

function advanced([pattern, sound, word]) {
  return makePhonemeAtom({
    id: `gpc.adv.${pattern}`,
    type: "advanced",
    category: "Advanced",
    difficulty: 3,
    letter: pattern, sound, exampleWord: word,
  });
}

function sightWordAtom([word, similars]) {
  return {
    id: `sw.${word.toLowerCase()}`,
    type: "sight-word",
    category: "Sight words",
    difficulty: 2,
    prompt: word,
    sound: word,
    answer: word,
    choices: shuffle([word, ...similars]),
    accepted: deriveAccepted({ prompt: word, sound: word, answer: word }),
    targetLatencyMs: TARGET_LATENCY["sight-word"],
  };
}

function blendingAtom([word, parts, similars]) {
  return {
    id: `bl.${word}`,
    type: "blending",
    category: "Blending",
    difficulty: 3,
    prompt: `Blend the sounds: ${parts.join(" – ")}`,
    sound: word,
    answer: word,
    choices: shuffle([word, ...similars]),
    accepted: deriveAccepted({ prompt: word, sound: word, answer: word }),
    targetLatencyMs: TARGET_LATENCY["blending"],
  };
}

// ============================================================
// PHONEMIC AWARENESS (PA) ATOMS — pre-print, audio-first.
//
// PA atoms differ from the rest of the pool: the prompt the student
// REACTS TO is AUDIO (TTS-spoken), not visual orthography. The visual
// `prompt` field still exists for accessibility / older readers, but
// it's a plain-language instruction ("What word do these sounds
// make?"), not a letter or word to decode.
//
// Each PA atom has:
//   prompt       — text instruction shown on screen
//   audioPrompt  — what TTS speaks when the question loads
//                   (auto-played by the app; replayable via 🔊)
//   answer       — the correct response (word for blend/substitute,
//                   sound descriptor for initial/final)
//   choices      — 3 multiple-choice options
//   accepted     — speech-recognition forms (only meaningful when
//                   the answer is a real word)
// ============================================================

// PA-9 — blending: hear separated phonemes, identify the word.
// [word, [phonemes spoken with comma pauses], [distractor words]]
const PA_BLEND_WORDS = [
  ["cat",  ["kuh", "ahh", "tuh"],         ["cap",  "can"]],
  ["sun",  ["sss", "uh",  "nnn"],         ["sit",  "fun"]],
  ["dog",  ["duh", "ahh", "guh"],         ["log",  "dot"]],
  ["pet",  ["puh", "eh",  "tuh"],         ["pen",  "pat"]],
  ["map",  ["mmm", "ahh", "puh"],         ["mat",  "man"]],
  ["bug",  ["buh", "uh",  "guh"],         ["big",  "but"]],
  ["fish", ["fff", "ih",  "shh"],         ["fin",  "wish"]],
  ["ship", ["shh", "ih",  "puh"],         ["chip", "shop"]],
  ["chop", ["chuh","ahh", "puh"],         ["shop", "chip"]],
  ["thin", ["thuh","ih",  "nnn"],         ["thumb","then"]],
  ["run",  ["rrr", "uh",  "nnn"],         ["ran",  "rug"]],
  ["win",  ["www", "ih",  "nnn"],         ["wig",  "won"]],
  ["top",  ["tuh", "ahh", "puh"],         ["tap",  "tip"]],
  ["bed",  ["buh", "eh",  "duh"],         ["bad",  "bid"]],
  ["mom",  ["mmm", "ahh", "mmm"],         ["mop",  "mat"]],
];

// PA-5 — initial-sound isolation. Student hears a word, picks the sound
// it starts with from three options.
// [word, firstLetter] — the first sound is /firstLetter/
const PA_INITIAL_WORDS = [
  ["cat",  "c"], ["sun",  "s"], ["dog",  "d"],
  ["pig",  "p"], ["mom",  "m"], ["fish", "f"],
  ["top",  "t"], ["leg",  "l"],
];

// PA-14 — substitution. Student hears the original word + a swap
// instruction, picks the new word from three options.
// [original, swapFromLetter, swapToLetter, newWord]
const PA_SUBSTITUTE_PAIRS = [
  ["cat", "c", "h", "hat"],
  ["man", "m", "c", "can"],
  ["run", "r", "f", "fun"],
  ["pen", "p", "t", "ten"],
  ["big", "b", "p", "pig"],
  ["mat", "m", "b", "bat"],
  ["cap", "c", "t", "tap"],
  ["sun", "s", "b", "bun"],
];

// Build a PA-9 blending atom.
function paBlendAtom([word, parts, distractors]) {
  return {
    id: `pa9.${word}`,
    type: "pa-blend",
    category: "Blending sounds",
    difficulty: 2,
    prompt: "What word do these sounds make?",
    audioPrompt: parts.join(", "),
    answer: word,
    choices: shuffle([word, ...distractors]),
    accepted: deriveAccepted({ prompt: word, sound: word, answer: word }),
    sound: word, // hint sound on wrong answer = the blended word
    targetLatencyMs: TARGET_LATENCY["pa-blend"],
  };
}

// Build a PA-5 initial-sound atom.
function paInitialAtom([word, letter]) {
  const exampleWord = SINGLE_CONSONANTS.find(([l]) => l === letter)?.[2]
    || SHORT_VOWELS.find(([l]) => l === letter)?.[2]
    || word;
  const correct = describePhoneme(letter, exampleWord);
  const distractors = pickRandom(ALL_PHONEME_DESCRIPTORS, 2, new Set([correct]));
  const sound = (SINGLE_CONSONANTS.find(([l]) => l === letter) ||
                 SHORT_VOWELS.find(([l]) => l === letter))?.[1] || letter;
  return {
    id: `pa5.${word}`,
    type: "pa-initial",
    category: "First sound",
    difficulty: 1,
    prompt: `What sound does "${word}" start with?`,
    audioPrompt: `What sound does ${word} start with?`,
    answer: correct,
    choices: shuffle([correct, ...distractors]),
    sound, // hint = the correct phoneme
    targetLatencyMs: TARGET_LATENCY["pa-initial"],
  };
}

// ============================================================
// TIER-2 VOCABULARY (Phase 1 §3.1: VO-2)
//
// High-utility academic words that appear across domains and unlock
// comprehension. Phase 1 calls Tier-2 the "explicit-instruction sweet
// spot": these need direct teaching because they're rare in casual
// speech but common in school texts.
//
// Format: [word, definition, [two distractor definitions]]
// The student sees the word, picks the meaning from 3 options.
// ============================================================
const VOCAB_TIER2 = [
  ["analyze",      "to study carefully",     ["to throw away",       "to listen quietly"]],
  ["observe",      "to watch closely",       ["to forget about",     "to make up"]],
  ["contrast",     "to show how things differ", ["to add together",  "to make smaller"]],
  ["compare",      "to look at how things are alike", ["to break apart", "to ignore"]],
  ["predict",      "to guess what will happen", ["to remember the past", "to repeat"]],
  ["demonstrate",  "to show how something works", ["to hide", "to forget"]],
  ["describe",     "to tell what something is like", ["to count", "to throw"]],
  ["identify",     "to point out or name",   ["to lose",             "to undo"]],
  ["evaluate",     "to judge how good something is", ["to ignore", "to take apart"]],
  ["summarize",    "to tell the main parts shortly", ["to make longer", "to copy exactly"]],
  ["explain",      "to make something clear", ["to confuse",         "to forget"]],
  ["interpret",    "to figure out the meaning", ["to break",         "to argue"]],
  ["conclude",     "to decide after thinking", ["to start over",     "to give up"]],
  ["infer",        "to figure out from clues", ["to copy",           "to guess wildly"]],
  ["justify",      "to give a good reason for", ["to apologize for", "to deny"]],
  ["distinguish",  "to tell things apart",   ["to mix together",    "to forget"]],
  ["organize",     "to put things in order",  ["to break things",   "to throw away"]],
  ["classify",     "to sort into groups",    ["to count one by one", "to mix up"]],
  ["examine",      "to look at very carefully", ["to glance at",    "to hide"]],
  ["fortunate",    "lucky",                  ["sad",                "angry"]],
  ["determine",    "to figure out for sure", ["to guess",           "to forget"]],
  ["consider",     "to think carefully about", ["to ignore",        "to laugh at"]],
  ["estimate",     "to make a careful guess", ["to count exactly",  "to argue"]],
  ["construct",    "to build",               ["to break down",      "to throw away"]],
  ["complete",     "finished or whole",      ["broken",             "missing"]],
  ["familiar",     "well-known",             ["strange",            "scary"]],
  ["essential",    "very important",         ["unimportant",        "extra"]],
  ["enormous",     "very large",             ["tiny",               "average"]],
  ["responsible",  "in charge of doing something well", ["lazy", "careless"]],
  ["curious",      "wanting to learn more",  ["bored",              "afraid"]],
];

// ============================================================
// PICTURE-WORD ATOMS — show an emoji, student reads/picks the word.
//
// Tests both decoding (recognise the word's spelling) and lexical
// familiarity (know what the picture is called). Emoji is a free,
// universal v1 stand-in for real illustrated assets — every device
// renders them and kids recognise them immediately.
//
// Format: [emoji, word, [two distractor words]]
// Distractors should be visually + phonologically close to the target
// so the kid can't guess by elimination on shape alone.
// ============================================================
const PICTURE_WORDS = [
  ["🐛", "bug",   ["bag", "big"]],
  ["🐱", "cat",   ["cap", "can"]],
  ["🐶", "dog",   ["dot", "log"]],
  ["🐟", "fish",  ["fin",  "wish"]],
  ["☀️", "sun",   ["son",  "sit"]],
  ["🚗", "car",   ["cat",  "cup"]],
  ["🚌", "bus",   ["bun",  "bus"]],   // duplicate-as-distractor: dropped below
  ["🐝", "bee",   ["bed",  "bat"]],
  ["🐮", "cow",   ["cat",  "cup"]],
  ["🐷", "pig",   ["pin",  "pup"]],
  ["🐸", "frog",  ["fog",  "frog"]],   // dropped below
  ["🎩", "hat",   ["mat",  "cat"]],
  ["🧦", "sock",  ["sick", "rock"]],
  ["🛏️", "bed",   ["bid",  "bad"]],
  ["🥚", "egg",   ["pig",  "leg"]],
  ["🐔", "hen",   ["pen",  "hat"]],
  ["🌳", "tree",  ["three","free"]],
  ["🐍", "snake", ["snail","steak"]],
  ["🦁", "lion",  ["line", "lion"]],   // dropped below
  ["🍰", "cake",  ["cape", "cane"]],
  ["✏️", "pen",   ["pin",  "pan"]],
  ["🌽", "corn",  ["born", "cone"]],
  ["🦆", "duck",  ["dock", "luck"]],
  ["⚾", "ball",  ["bell", "bull"]],
  ["🐑", "sheep", ["ship", "sleep"]],
  ["🐭", "mouse", ["moose","house"]],
  ["🚂", "train", ["rain", "brain"]],
  ["🐺", "wolf",  ["wood", "wolf"]],   // dropped below
  ["🌙", "moon",  ["noon", "spoon"]],
  ["🍎", "apple", ["ample","apply"]],
];

// Strip any rows where a distractor accidentally equals the answer
// (a few entries above were placeholder reminders).
const _PICTURES = PICTURE_WORDS.filter(
  ([, w, distractors]) => !distractors.includes(w)
);

function pictureWordAtom([emoji, word, distractors]) {
  return {
    id: `pic.${word.toLowerCase()}`,
    type: "picture-word",
    category: "Picture Words",
    difficulty: 2,
    prompt: emoji,
    sound: word,
    answer: word,
    choices: shuffle([word, ...distractors]),
    accepted: deriveAccepted({ prompt: word, sound: word, answer: word }),
    targetLatencyMs: TARGET_LATENCY["picture-word"],
  };
}

// Build a Tier-2 vocab atom.
function vocabAtom([word, definition, distractors]) {
  return {
    id: `vocab.${word.toLowerCase()}`,
    type: "vocab-tier2",
    category: "Vocabulary",
    difficulty: 3,
    prompt: word,
    sound: word,
    answer: definition,
    choices: shuffle([definition, ...distractors]),
    accepted: deriveAccepted({ prompt: word, sound: word, answer: word }),
    targetLatencyMs: TARGET_LATENCY["vocab-tier2"],
  };
}

// Build a PA-14 substitution atom.
function paSubstituteAtom([original, fromLetter, toLetter, newWord]) {
  // Distractors: keep original (no swap done), swap to a different letter.
  const distractors = [original];
  // Add a "wrong swap" distractor — original with a different first letter.
  const wrongSwaps = ["b", "c", "d", "f", "g", "h", "m", "n", "p", "r", "s", "t"]
    .filter((l) => l !== fromLetter && l !== toLetter && l !== original[0])
    .slice(0, 1);
  if (wrongSwaps.length > 0) {
    distractors.push(wrongSwaps[0] + original.slice(1));
  } else {
    distractors.push(original);
  }
  return {
    id: `pa14.${original}-${newWord}`,
    type: "pa-substitute",
    category: "Sound swap",
    difficulty: 3,
    prompt: `Change the first sound in "${original}" from /${fromLetter}/ to /${toLetter}/. What word do you get?`,
    audioPrompt: `Change the first sound in ${original}, from ${fromLetter}, to ${toLetter}. What word do you get?`,
    answer: newWord,
    choices: shuffle([newWord, ...distractors]),
    accepted: deriveAccepted({ prompt: newWord, sound: newWord, answer: newWord }),
    sound: newWord, // hint on wrong = the new word
    targetLatencyMs: TARGET_LATENCY["pa-substitute"],
  };
}

// ============================================================
// EXPORT — flatten everything into the QUESTIONS pool app.js consumes
// ============================================================

export const QUESTIONS = [
  ...SINGLE_CONSONANTS.map(letterSound),
  ...SHORT_VOWELS.map(shortVowel),
  ...SILENT_E.map(silentEAtom),
  ...DIGRAPHS.map(digraph),
  ...BLENDS.map(blend),
  ...VOWEL_TEAMS.map(vowelTeam),
  ...R_CONTROLLED.map(rControlled),
  ...SOFT_C_G.map(softCG),
  ...ADVANCED.map(advanced),
  ...SIGHT_WORDS.map(sightWordAtom),
  ...BLENDING_WORDS.map(blendingAtom),
  ...PA_BLEND_WORDS.map(paBlendAtom),
  ...PA_INITIAL_WORDS.map(paInitialAtom),
  ...PA_SUBSTITUTE_PAIRS.map(paSubstituteAtom),
  ...VOCAB_TIER2.map(vocabAtom),
  ..._PICTURES.map(pictureWordAtom),
];

// Also export the map so app.js (or future engine code) can look up
// thresholds by atom type without re-deriving them.
export { TARGET_LATENCY };
