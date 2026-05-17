// ============================================================
// Reading Facts — main app
//
// Top-level flow:
//   not signed in   →  Login screen (magic-link email)
//   signed in, no student selected  →  Student picker
//   student selected →  Quiz + dashboard, with a top bar showing
//                       the student's name and a "⋯" menu containing
//                       "Switch student" and "Sign out".
//
// We connect to the SAME Supabase project as the math facts app, so
// VPA students who already have an account work here too.
// ============================================================

import { QUESTIONS } from "../data/questions.js";
import {
  getSession,
  onAuthChange,
  signInWithMagicLink,
  signInWithPassword,
  signUpWithPassword,
  signOut,
} from "./auth.js";
import {
  listStudents,
  createStudent,
  getStudentById,
  rememberCurrentStudent,
  forgetCurrentStudent,
  readCurrentStudentId,
} from "./students.js";
import {
  loadMastery,
  recordAttempt,
  getMasteryScore,
  hasAnyMastery,
  masteredAtomCount,
} from "./mastery.js";
import {
  recordSession,
  getTodayStats,
} from "./sessions.js";

// ----- Tunable constants -----
const QUIZ_LENGTH = 10;            // normal practice quiz length
const DIAGNOSTIC_LENGTH = 12;      // first-ever quiz: longer + spans difficulties
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 3;

// Daily-XP loop, mirroring the math facts app: 1 minute of active
// quiz time = 1 XP; daily goal = 5 XP (i.e., ~5 minutes of practice
// per day fills the effort ring). Both apps share the same units so
// future cross-app reporting works without translation.
const DAILY_GOAL_XP = 5;
function xpFromSec(sec) {
  // One decimal place, e.g. 90 sec → 1.5 XP.
  return Math.round((sec / 60) * 10) / 10;
}

// The four learning strands the home screen offers as cards. Each
// strand is an aggregation of atom types that fit together
// pedagogically. Click a strand card on home → start a quiz filtered
// to atoms of those types only.
const STRANDS = {
  phonics: {
    label: "Phonics",
    symbol: "Aa",
    description: "Letter sounds & decoding",
    atomTypes: ["letter-sound", "digraph", "blend", "silent-e",
                "vowel-team", "r-controlled", "soft", "advanced"],
  },
  sight: {
    label: "Sight Words",
    symbol: "the",
    description: "Instant word recognition",
    atomTypes: ["sight-word"],
  },
  pa: {
    label: "Phoneme Sounds",
    symbol: "🔊",
    description: "Listen, blend, swap",
    atomTypes: ["pa-blend", "pa-initial", "pa-substitute", "pa-final"],
  },
  blending: {
    label: "Blending",
    symbol: "→",
    description: "Sounds into words",
    atomTypes: ["blending"],
  },
  vocab: {
    label: "Vocabulary",
    symbol: "📖",
    description: "Word meanings",
    atomTypes: ["vocab-tier2"],
  },
  pictures: {
    label: "Picture Words",
    symbol: "🐛",
    description: "See it, read it",
    atomTypes: ["picture-word"],
  },
};

// Per-Phase-1 §1.2: an answer counts as MASTERED only when it is
// correct AND lands under that atom's target latency. Anything else
// is "accurate-slow" or "wrong" — both keep the atom in active rotation.
//
// classifyAnswer() returns one of:
//   "mastered"  → correct + fast (≤ target latency)
//   "accurate"  → correct but slow
//   "wrong"     → incorrect
function classifyAnswer(question, isCorrect, latencyMs) {
  if (!isCorrect) return "wrong";
  const target = question.targetLatencyMs ?? 3000;
  return latencyMs <= target ? "mastered" : "accurate";
}

// Speech recognition support — Chrome/Edge/Safari yes, Firefox no.
const SR =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;
const SUPPORTS_SPEECH = !!SR;

// Now that every atom carries `accepted` for speech matching, the full
// QUESTIONS pool is usable in both modes — no filtering needed.
const POOL = QUESTIONS;

// Per-Phase-1 §1.2: production beats recognition for low-level decoding.
// So speech is the DEFAULT input mode for atom types that map to a
// pronounceable target (letter sounds, digraphs, sight words, blending,
// etc.). Multiple-choice stays as the fallback when speech isn't
// supported, or when the user opts out via the on-screen toggle.
const SPEECH_FIRST_TYPES = new Set([
  "letter-sound", "digraph", "blend", "silent-e",
  "vowel-team", "r-controlled", "soft", "advanced",
  "sight-word", "blending", "speak",
  // PA atoms whose answer is a real word — speech is natural here.
  // pa-initial / pa-final answer is a phoneme descriptor, MC stays default.
  "pa-blend", "pa-substitute",
  // Picture-word: student sees an emoji and says the word. Real-word
  // production, so speech is the right default.
  "picture-word",
]);

const INPUT_MODE_KEY = "vpa-reading-input-mode";
function readInputMode() {
  const v = localStorage.getItem(INPUT_MODE_KEY);
  return v === "mc" || v === "speech" ? v : "auto";
}
function writeInputMode(mode) {
  if (mode === "auto") localStorage.removeItem(INPUT_MODE_KEY);
  else localStorage.setItem(INPUT_MODE_KEY, mode);
}
let inputModePreference = readInputMode();

// Decide which input UI to render for this question.
function shouldUseSpeechInput(question) {
  if (!SUPPORTS_SPEECH) return false;
  if (inputModePreference === "mc") return false;
  if (inputModePreference === "speech") return true;
  return SPEECH_FIRST_TYPES.has(question.type);
}

// Friendly instruction text for speech mode, varies by atom type.
function instructionForSpeech(question) {
  switch (question.type) {
    case "sight-word":    return "Read this word out loud.";
    case "blending":      return "Blend the sounds and say the word.";
    case "vowel-team":
    case "r-controlled":  return "Say the sound these letters make.";
    case "digraph":
    case "blend":         return "Say the sound these letters make together.";
    case "silent-e":      return "Say the sound this pattern makes.";
    case "letter-sound":  return "Say the sound this letter makes.";
    case "pa-blend":      return "Listen to the sounds, then say the word.";
    case "pa-substitute": return "Listen to the swap, then say the new word.";
    case "picture-word":  return "Say the word for this picture.";
    default:              return "Say it out loud.";
  }
}

// ----- Top-level app state -----
let session = null;        // Supabase session, or null
let currentStudent = null; // selected student record, or null
let isGuest = false;       // true when using the "Continue as guest" path
let isDiagnostic = false;  // true on a student's very first quiz
let authMode = "signin";   // "signin" | "signup" | "magic" — login tab

// Top-level screen the post-auth UI is currently showing.
//   "home"    → strand picker / today's plan (renderHome)
//   "quiz"    → an in-progress quiz (renderQuestion → renderDashboard)
//   "summary" → end-of-quiz dashboard
let screen = "home";

// When the user clicks a specific strand on home, we filter the atom
// pool to that strand's types only. null = no filter (used by the
// diagnostic and any "all" quiz).
let quizFilter = null;

// Which strand's detail screen the user is currently viewing
// (only meaningful when screen === "strand-detail").
let viewedStrand = null;

// Cache of today's session stats; populated by enterStudent and
// refreshed after each quiz so renderHome can render rings synchronously.
let todayStats = { sessions: 0, total_attempts: 0, correct_count: 0, mastered_count: 0, duration_sec: 0 };

function effectiveQuizLength() {
  return isDiagnostic ? DIAGNOSTIC_LENGTH : QUIZ_LENGTH;
}

// ----- Quiz state -----
//   answeredIds       — Set of question indexes already shown this quiz
//   currentQuestion   — the question object on screen right now
//   currentQuestionId — its index in QUESTIONS (for the answeredIds Set)
//   currentDifficulty — 1..3, adapts after each answer
//   maxDifficulty     — highest difficulty the student reached this quiz
//   results           — one entry per answered question (used by dashboard)
let answeredIds = new Set();
let currentQuestion = null;
let currentQuestionId = -1;
let currentDifficulty = 1;
let maxDifficulty = 1;
let results = [];
let answered = false;
let questionStart = 0;
let quizStart = 0;

const app = document.getElementById("app");

// ============================================================
// BOOT — figure out auth + saved student, then render
// ============================================================
async function boot() {
  try {
    renderLoading("Loading…");

    session = await getSession();

    // Re-render whenever auth changes (e.g. user clicks magic link).
    onAuthChange(async (newSession) => {
      session = newSession;
      if (!session) {
        currentStudent = null;
        forgetCurrentStudent();
      }
      try {
        await routeAfterAuth();
      } catch (err) {
        renderStartupError(err);
      }
    });

    await routeAfterAuth();
  } catch (err) {
    renderStartupError(err);
  }
}

// Last-resort error screen so a crash never leaves the user with
// a blank white card.
function renderStartupError(err) {
  console.error("Reading app startup error:", err);
  const message = (err && err.message) || String(err);
  app.innerHTML = `
    <div class="brand-mark">VPA</div>
    <h1 class="auth-title">Something went wrong</h1>
    <p class="auth-subtitle">
      The app couldn't start. The error was:
    </p>
    <div class="code-block">${escapeHtml(message)}</div>
    <p class="auth-subtitle">
      Check the browser console (right-click → Inspect → Console)
      for more detail, then refresh the page.
    </p>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function routeAfterAuth() {
  if (!session) {
    renderLogin();
    return;
  }

  // Try to restore a previously-selected student.
  const savedId = readCurrentStudentId();
  if (savedId) {
    const s = await getStudentById(savedId);
    if (s) {
      await enterStudent(s);
      return;
    }
    forgetCurrentStudent();
  }

  // Otherwise, show the picker.
  await renderStudentPicker();
}

// Shared "we have a student now → load their mastery and start"
// routine. Called from routeAfterAuth (saved student), pickStudent
// (just chose one), and the auto-select branch in renderStudentPicker.
async function enterStudent(student) {
  currentStudent = student;
  isGuest = false;
  renderLoading("Loading progress…");
  try {
    await loadMastery(student.id);
  } catch (e) {
    console.warn("Mastery load failed:", e);
  }
  try {
    todayStats = await getTodayStats(student.id);
  } catch (e) {
    console.warn("Today stats load failed:", e);
    todayStats = { sessions: 0, total_attempts: 0, correct_count: 0, mastered_count: 0, duration_sec: 0 };
  }

  // First-time student: jump straight into the diagnostic quiz.
  // Returning student: land on the home screen so they can pick.
  if (hasAnyMastery()) {
    isDiagnostic = false;
    quizFilter = null;
    screen = "home";
  } else {
    isDiagnostic = true;
    quizFilter = null;
    screen = "quiz";
  }
  resetQuiz();
  render();
}

// ============================================================
// SCREEN: Loading
// ============================================================
function renderLoading(label = "Loading…") {
  document.body.classList.remove("warm-bg");
  app.innerHTML = `<div class="auth-loading">${label}</div>`;
}

// ============================================================
// SCREEN: Login — three modes via tabs at the top
//   "signin" → email + password (no email sent, no rate limit)
//   "signup" → email + password to create a new account
//   "magic"  → magic-link email (rate-limited)
// "Continue as guest" stays available in all three modes.
// ============================================================
function renderLogin() {
  document.body.classList.remove("warm-bg");

  const tab = (mode, label) =>
    `<button type="button" class="auth-tab${authMode === mode ? " active" : ""}" data-mode="${mode}">${label}</button>`;

  // The form changes based on the active mode.
  let formHTML;
  if (authMode === "magic") {
    formHTML = `
      <p class="auth-subtitle">We'll email you a one-time link. No password.</p>
      <form id="login-form">
        <input type="email" id="login-email" class="auth-input"
               placeholder="parent@email.com" required autofocus autocomplete="email" />
        <button type="submit" class="primary-btn auth-submit" id="login-submit">
          Send sign-in link
        </button>
        <div class="auth-error" id="login-error"></div>
      </form>
    `;
  } else {
    const isSignup = authMode === "signup";
    formHTML = `
      <p class="auth-subtitle">
        ${isSignup
          ? "Create an account with a password — no email needed."
          : "Sign in with your email and password."}
      </p>
      <form id="login-form">
        <input type="email" id="login-email" class="auth-input"
               placeholder="parent@email.com" required autofocus autocomplete="email" />
        <input type="password" id="login-password" class="auth-input"
               placeholder="${isSignup ? "Choose a password (6+ characters)" : "Password"}"
               required minlength="6"
               autocomplete="${isSignup ? "new-password" : "current-password"}" />
        <button type="submit" class="primary-btn auth-submit" id="login-submit">
          ${isSignup ? "Create account" : "Sign in"}
        </button>
        <div class="auth-error" id="login-error"></div>
      </form>
    `;
  }

  app.innerHTML = `
    <div class="brand-mark">VPA</div>

    <div class="auth-tabs">
      ${tab("signin", "Sign in")}
      ${tab("signup", "Create account")}
      ${tab("magic", "Email link")}
    </div>

    ${formHTML}

    <div class="auth-divider">or</div>

    <button type="button" class="secondary-btn auth-restart" id="guest-btn">
      Continue as guest
    </button>
    <div class="auth-subtitle" style="margin-top:8px; font-size:13px;">
      Guest mode lets you try the quiz without signing in.<br>
      Progress isn't saved.
    </div>
  `;

  // Tab switching.
  document.querySelectorAll(".auth-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      authMode = btn.dataset.mode;
      renderLogin();
    });
  });

  // Wire the guest button (always shown).
  document.getElementById("guest-btn").addEventListener("click", enterGuestMode);

  const form = document.getElementById("login-form");
  const emailEl = document.getElementById("login-email");
  const passEl = document.getElementById("login-password"); // null in magic mode
  const submitEl = document.getElementById("login-submit");
  const errorEl = document.getElementById("login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailEl.value.trim();
    const password = passEl ? passEl.value : "";
    if (!email) return;
    if (authMode !== "magic" && password.length < 6) {
      errorEl.textContent = "Password must be at least 6 characters.";
      return;
    }

    const originalLabel = submitEl.textContent;
    submitEl.disabled = true;
    submitEl.textContent = "Working…";
    errorEl.textContent = "";

    let result;
    if (authMode === "signin") {
      result = await signInWithPassword(email, password);
    } else if (authMode === "signup") {
      result = await signUpWithPassword(email, password);
    } else {
      result = await signInWithMagicLink(email);
    }

    if (result.error) {
      submitEl.disabled = false;
      submitEl.textContent = originalLabel;
      errorEl.textContent =
        result.error.message || "Something went wrong. Try again.";
      return;
    }

    if (authMode === "magic") {
      renderEmailSent(email);
      return;
    }

    // For sign-up: if Supabase is set to require email confirmation,
    // there will be NO session yet. Tell the user to check email.
    if (authMode === "signup" && !result.data.session) {
      renderEmailSent(email);
      return;
    }

    // Otherwise we have a session — onAuthChange will route to the
    // student picker. Nothing more to do here.
  });
}

function enterGuestMode() {
  isGuest = true;
  isDiagnostic = false; // guests skip diagnostic — no persistence anyway
  currentStudent = { id: "guest", display_name: "Guest" };
  loadMastery("guest"); // clears the cache
  todayStats = { sessions: 0, total_attempts: 0, correct_count: 0, mastered_count: 0, duration_sec: 0 };
  quizFilter = null;
  screen = "home";
  resetQuiz();
  render();
}

function renderEmailSent(email) {
  app.innerHTML = `
    <div class="brand-mark">VPA</div>
    <h1 class="auth-title">Check your email</h1>
    <p class="auth-subtitle">
      We sent a sign-in link to <strong>${email}</strong>. Tap it on this device to continue.
    </p>
    <button type="button" class="secondary-btn auth-restart" id="back-to-login">
      Use a different email
    </button>
  `;
  document.getElementById("back-to-login").addEventListener("click", renderLogin);
}

// ============================================================
// SCREEN: Student picker
// ============================================================
async function renderStudentPicker() {
  document.body.classList.remove("warm-bg");
  renderLoading("Loading students…");

  let students;
  try {
    students = await listStudents();
  } catch (e) {
    app.innerHTML = `<div class="auth-error">Could not load students: ${e.message}</div>`;
    return;
  }

  // Auto-select if exactly one — same behavior as math.
  if (students.length === 1) {
    pickStudent(students[0]);
    return;
  }

  // No students yet → onboarding form.
  if (students.length === 0) {
    renderAddStudent();
    return;
  }

  // Multiple → list them.
  app.innerHTML = `
    <div class="brand-mark">VPA</div>
    <h1 class="auth-title">Who's reading?</h1>
    <div class="student-list" id="student-list"></div>
    <button type="button" class="secondary-btn picker-signout" id="picker-signout">
      Sign out
    </button>
  `;

  const listEl = document.getElementById("student-list");
  students.forEach((s) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "student-card";
    btn.innerHTML = `
      <span class="student-name">${s.display_name}</span>
      ${s.grade_level != null ? `<span class="student-grade">Grade ${s.grade_level}</span>` : ""}
    `;
    btn.addEventListener("click", () => pickStudent(s));
    listEl.appendChild(btn);
  });

  document
    .getElementById("picker-signout")
    .addEventListener("click", handleSignOut);
}

function renderAddStudent() {
  app.innerHTML = `
    <div class="brand-mark">VPA</div>
    <h1 class="auth-title">Add a student</h1>
    <p class="auth-subtitle">Who's reading? You can add more later.</p>
    <form id="add-student-form">
      <input
        type="text"
        id="new-name"
        class="auth-input"
        placeholder="Student name"
        required
        autofocus
      />
      <input
        type="number"
        id="new-grade"
        class="auth-input"
        placeholder="Grade (optional)"
        min="0"
        max="12"
      />
      <button type="submit" class="primary-btn auth-submit" id="add-submit">
        Continue
      </button>
      <div class="auth-error" id="add-error"></div>
    </form>
    <button type="button" class="secondary-btn picker-signout" id="add-signout">
      Sign out
    </button>
  `;

  const form = document.getElementById("add-student-form");
  const nameEl = document.getElementById("new-name");
  const gradeEl = document.getElementById("new-grade");
  const submitEl = document.getElementById("add-submit");
  const errorEl = document.getElementById("add-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameEl.value.trim();
    if (!name) return;
    submitEl.disabled = true;
    submitEl.textContent = "Creating…";
    errorEl.textContent = "";
    try {
      const newStudent = await createStudent(name, gradeEl.value);
      pickStudent(newStudent);
    } catch (err) {
      submitEl.disabled = false;
      submitEl.textContent = "Continue";
      errorEl.textContent = err.message || "Could not create student.";
    }
  });

  document
    .getElementById("add-signout")
    .addEventListener("click", handleSignOut);
}

// ============================================================
// SCREEN: Home — strand picker + today's plan
// ============================================================

// Aggregate stats for one strand from the in-memory mastery cache.
// Returns { total, mastered, pct } where mastered counts atoms with
// score ≥ 0.7. Works for guests too (just returns 0/0 since no cache).
function computeStrandStats(strandId) {
  const types = STRANDS[strandId].atomTypes;
  const atoms = POOL.filter((q) => types.includes(q.type));
  const mastered = atoms.filter((q) => getMasteryScore(q.id) >= 0.7).length;
  return {
    total: atoms.length,
    mastered,
    pct: atoms.length > 0 ? mastered / atoms.length : 0,
  };
}

// Pick the strand to recommend on home: lowest mastery percentage
// among strands that still have unmastered atoms. Returns the strand
// id, or null if everything's mastered.
function recommendedStrand() {
  let best = null;
  let bestPct = 1.01;
  for (const id of Object.keys(STRANDS)) {
    const s = computeStrandStats(id);
    if (s.total === 0) continue;
    if (s.mastered === s.total) continue; // fully mastered, skip
    if (s.pct < bestPct) {
      bestPct = s.pct;
      best = id;
    }
  }
  return best;
}

function renderHome() {
  const rec = recommendedStrand();
  const overallMastered = isGuest ? 0 : masteredAtomCount();

  // XP-based daily plan, matching the math facts loop. Every minute
  // of session time = 1 XP. Effort ring fills as XP approaches goal.
  const todayXp = xpFromSec(todayStats.duration_sec || 0);
  const goalHit = todayXp >= DAILY_GOAL_XP;
  const remainingMin = Math.max(0, Math.ceil(DAILY_GOAL_XP - todayXp));

  let planLine;
  if (isGuest) {
    planLine = "Try any strand to start.";
  } else if (goalHit) {
    planLine = "Goal complete — bonus rep?";
  } else if (!rec) {
    planLine = "Everything mastered — keep refreshing!";
  } else {
    planLine = `${remainingMin} min · Start with ${STRANDS[rec].label}`;
  }

  // Rings derive from today's quiz performance:
  //   effort   = today's XP / daily goal
  //   accuracy = today's correct / today's attempts
  //   mastery  = today's mastered / today's attempts
  const effort = Math.min(1, todayXp / DAILY_GOAL_XP);
  const accuracy = todayStats.total_attempts > 0
    ? todayStats.correct_count / todayStats.total_attempts : 0;
  const mastery = todayStats.total_attempts > 0
    ? todayStats.mastered_count / todayStats.total_attempts : 0;

  const cards = Object.entries(STRANDS).map(([id, strand]) => {
    const s = computeStrandStats(id);
    const isRec = id === rec;
    return `
      <button type="button"
              class="strand-card${isRec ? " strand-card-recommended" : ""}"
              data-strand="${id}">
        <span class="strand-symbol">${strand.symbol}</span>
        <span class="strand-label">${strand.label}</span>
        <span class="strand-meta">${s.mastered} / ${s.total} mastered</span>
        <span class="strand-submeta">${strand.description}</span>
        <div class="strand-progress-track">
          <div class="strand-progress-fill" style="width: ${Math.round(s.pct * 100)}%"></div>
        </div>
      </button>
    `;
  }).join("");

  const overallLine = isGuest
    ? "Guest mode — progress isn't saved"
    : `${overallMastered} atom${overallMastered === 1 ? "" : "s"} mastered overall · ${todayStats.sessions} session${todayStats.sessions === 1 ? "" : "s"} today`;

  app.innerHTML = `
    ${topBarHTML()}
    <div class="eyebrow">Today's plan</div>
    <div class="plan-line">${planLine}</div>

    <div class="rings-wrap home-rings">
      ${ringsSvg(effort, accuracy, mastery, 180, 14, 5)}
      <div class="rings-center">
        <div class="rings-xp">${todayXp.toFixed(1)}</div>
        <div class="rings-label">of ${DAILY_GOAL_XP} XP</div>
      </div>
    </div>

    <div class="rings-legend">
      <div class="legend-item"><span class="dot" style="background:#fa3e3e"></span>Effort</div>
      <div class="legend-item"><span class="dot" style="background:#9aff00"></span>Accuracy</div>
      <div class="legend-item"><span class="dot" style="background:#3bc1f3"></span>Mastery</div>
    </div>

    <div class="streak-line">${overallLine}</div>
    <div class="strand-grid">${cards}</div>
  `;

  // Strand cards open the detail screen (which has a "Start practicing"
  // button). This gives a chance to inspect mastery before practicing.
  document.querySelectorAll(".strand-card").forEach((btn) => {
    btn.addEventListener("click", () => openStrandDetail(btn.dataset.strand));
  });
}

// ============================================================
// SCREEN: Strand detail — atom list with individual mastery bars
// ============================================================
function openStrandDetail(strandId) {
  viewedStrand = strandId;
  screen = "strand-detail";
  render();
}

function renderStrandDetail() {
  const strand = STRANDS[viewedStrand];
  if (!strand) {
    backToHome();
    return;
  }

  const types = strand.atomTypes;
  // Pull all atoms in this strand, sorted by mastery score ascending
  // (so the atoms most needing work are at the top).
  const atoms = POOL
    .filter((q) => types.includes(q.type))
    .map((q) => ({ q, score: getMasteryScore(q.id) }))
    .sort((a, b) => a.score - b.score);

  const stats = computeStrandStats(viewedStrand);
  const pct = Math.round(stats.pct * 100);

  const rows = atoms.map(({ q, score }) => {
    const scorePct = Math.round(score * 100);
    const masteredFlag = score >= 0.7 ? " atom-row-mastered" : "";
    // For long instruction-style prompts, show the answer instead.
    const label = q.prompt && q.prompt.length > 14 ? q.answer : q.prompt;
    return `
      <div class="atom-row${masteredFlag}">
        <span class="atom-prompt">${escapeHtml(label)}</span>
        <div class="atom-bar-track">
          <div class="atom-bar-fill" style="width: ${scorePct}%"></div>
        </div>
        <span class="atom-score">${scorePct}%</span>
      </div>
    `;
  }).join("");

  app.innerHTML = `
    ${topBarHTML()}
    <div class="strand-detail-header">
      <span class="strand-detail-symbol">${strand.symbol}</span>
      <h1 class="strand-detail-title">${strand.label}</h1>
      <p class="strand-detail-sub">
        ${stats.mastered} of ${stats.total} mastered · ${pct}%
      </p>
    </div>
    <div class="strand-detail-actions">
      <button class="primary-btn" id="detail-practice">Practice this strand</button>
    </div>
    <div class="atom-list">${rows}</div>
  `;

  document.getElementById("detail-practice").addEventListener("click",
    () => startStrandQuiz(viewedStrand));
}

// Start a quiz filtered to one strand.
function startStrandQuiz(strandId) {
  quizFilter = strandId;
  isDiagnostic = false; // explicit strand pick is never a diagnostic
  screen = "quiz";
  resetQuiz();
  render();
}

// Return to the home screen from anywhere (typically the dashboard's
// "Done" button).
function backToHome() {
  quizFilter = null;
  screen = "home";
  resetQuiz();
  render();
}

async function pickStudent(student) {
  rememberCurrentStudent(student);
  await enterStudent(student);
}

// ============================================================
// 3-DOTS MENU helpers
// ============================================================
let menuOpen = false;

function toggleMenu(open) {
  menuOpen = open === undefined ? !menuOpen : open;
  const dropdown = document.getElementById("menu-dropdown");
  if (dropdown) {
    dropdown.style.display = menuOpen ? "block" : "none";
  }
}

// Close the menu when clicking anywhere outside it.
document.addEventListener("click", (e) => {
  if (!menuOpen) return;
  const wrap = document.getElementById("menu-wrap");
  if (wrap && !wrap.contains(e.target)) toggleMenu(false);
});

function topBarHTML() {
  if (!currentStudent) return "";
  // Guest mode has only "Exit guest mode". Guardians see "Switch student".
  const switchItem = isGuest
    ? ""
    : `<button type="button" class="menu-item" id="menu-switch">Switch student</button>`;
  const signOutLabel = isGuest ? "Exit guest mode" : "Sign out";

  // On any non-home screen, show a back arrow on the LEFT that returns
  // to the home screen (abandoning any in-progress quiz). The home
  // screen itself doesn't show one — there's nowhere further back.
  const backBtn = screen !== "home"
    ? `<button type="button" class="back-btn" id="back-to-home-btn" aria-label="Back to home">←</button>`
    : `<span class="back-btn-spacer"></span>`;

  return `
    <div class="top-bar">
      ${backBtn}
      <span class="top-bar-name">${currentStudent.display_name}</span>
      <div class="menu-wrap" id="menu-wrap">
        <button type="button" class="menu-btn" aria-label="Account menu" id="menu-btn">⋯</button>
        <div class="menu-dropdown" id="menu-dropdown" style="display:none">
          ${switchItem}
          <button type="button" class="menu-item" id="menu-signout">${signOutLabel}</button>
        </div>
      </div>
    </div>
  `;
}

function wireTopBar() {
  const btn = document.getElementById("menu-btn");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  const switchBtn = document.getElementById("menu-switch");
  if (switchBtn) {
    switchBtn.addEventListener("click", () => {
      toggleMenu(false);
      handleSwitchStudent();
    });
  }
  document.getElementById("menu-signout").addEventListener("click", () => {
    toggleMenu(false);
    handleSignOut();
  });
  // Back button: present on any non-home screen.
  const backBtn = document.getElementById("back-to-home-btn");
  if (backBtn) {
    backBtn.addEventListener("click", backToHome);
  }
}

async function handleSignOut() {
  // Guest mode is local-only — no Supabase session to clear.
  if (isGuest) {
    isGuest = false;
    currentStudent = null;
    renderLogin();
    return;
  }
  forgetCurrentStudent();
  currentStudent = null;
  await signOut(); // onAuthChange will re-render to the login screen
}

function handleSwitchStudent() {
  forgetCurrentStudent();
  currentStudent = null;
  renderStudentPicker();
}

// ============================================================
// QUIZ
// ============================================================
function resetQuiz() {
  answeredIds = new Set();
  currentQuestion = null;
  currentQuestionId = -1;
  currentDifficulty = 1;
  maxDifficulty = 1;
  results = [];
  answered = false;
}

// Top-level render — dispatches based on the `screen` state machine.
function render() {
  if (screen === "home") {
    document.body.classList.remove("warm-bg");
    renderHome();
    wireTopBar();
    return;
  }
  if (screen === "strand-detail") {
    document.body.classList.remove("warm-bg");
    renderStrandDetail();
    wireTopBar();
    return;
  }
  if (screen === "summary") {
    document.body.classList.add("warm-bg");
    renderDashboard();
    wireTopBar();
    return;
  }
  // screen === "quiz"
  renderQuizStep();
}

// Render one step of the quiz: either the next question, or the
// dashboard if we're done.
function renderQuizStep() {
  const questionsLeft =
    answeredIds.size < effectiveQuizLength() && answeredIds.size < filteredPoolLength();

  document.body.classList.toggle("warm-bg", !questionsLeft);

  if (!questionsLeft) {
    screen = "summary";
    renderDashboard();
    wireTopBar();
    return;
  }

  const next = pickNextQuestion();
  if (!next) {
    screen = "summary";
    renderDashboard();
    wireTopBar();
    return;
  }

  currentQuestion = next.q;
  currentQuestionId = next.i;
  renderQuestion(next.q);
  wireTopBar();
}

// How many atoms are eligible given the current quizFilter? Used by
// the termination check so a strand-filtered quiz ends when its pool
// is exhausted, not when the FULL pool is exhausted.
function filteredPoolLength() {
  if (!quizFilter) return POOL.length;
  const types = STRANDS[quizFilter].atomTypes;
  return POOL.filter((q) => types.includes(q.type)).length;
}

// Pick the next atom for this question.
//
// Three behaviors layered on top of each other:
//
//   1. DIAGNOSTIC mode (student's first quiz ever): cycle through
//      difficulty levels deterministically (1, 2, 3, 1, 2, 3, …) so
//      the diagnostic samples breadth across the curriculum.
//
//   2. NORMAL mode: pick atoms whose difficulty is near currentDifficulty
//      (with widening spread if no candidates). Within that band,
//      *prefer atoms with low mastery_score* — never-seen atoms (score
//      0) come first, then atoms the student is still struggling on.
//      Already-mastered atoms are deprioritised so practice time goes
//      where it matters.
//
//   3. NEVER repeat an atom within the same quiz (answeredIds).
function pickNextQuestion() {
  const filterTypes = quizFilter ? STRANDS[quizFilter].atomTypes : null;
  const all = POOL
    .map((q, i) => ({ q, i }))
    .filter(({ q, i }) =>
      !answeredIds.has(i) &&
      (!filterTypes || filterTypes.includes(q.type))
    );
  if (all.length === 0) return null;

  // DIAGNOSTIC: cycle 1 → 2 → 3 → 1 → 2 → 3 … to span difficulties.
  if (isDiagnostic) {
    const targetDifficulty = (answeredIds.size % MAX_DIFFICULTY) + MIN_DIFFICULTY;
    const slot = all.filter(({ q }) => q.difficulty === targetDifficulty);
    if (slot.length > 0) {
      return slot[Math.floor(Math.random() * slot.length)];
    }
    // Fall through to normal selection if that difficulty bucket is empty.
  }

  for (let spread = 0; spread <= MAX_DIFFICULTY - MIN_DIFFICULTY; spread++) {
    const candidates = all.filter(
      ({ q }) => Math.abs(q.difficulty - currentDifficulty) <= spread
    );
    if (candidates.length === 0) continue;

    // Mastery-weighted: prefer atoms the student has NOT mastered yet.
    // Sort ascending by mastery score, then take the lowest 30% and
    // pick randomly from there to add a little variety.
    candidates.sort((a, b) => getMasteryScore(a.q.id) - getMasteryScore(b.q.id));
    const cutoff = Math.max(1, Math.ceil(candidates.length * 0.3));
    const pool = candidates.slice(0, cutoff);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  return all[0]; // unreachable, but defensive
}

function renderQuestion(question) {
  answered = false;
  questionStart = Date.now();
  if (answeredIds.size === 0) quizStart = Date.now();

  const canSpeak = typeof window.speechSynthesis !== "undefined";

  // SIGHT WORDS in MC MODE need a different test format. The default
  // (show "was", pick "was" from was/saw/way) just tests visual matching,
  // not reading. Instead, we play the word as audio and ask the student
  // to pick the matching SPELLING — that's the orthographic-mapping test
  // sight words actually require. Speech mode is unchanged (show word,
  // student reads aloud → that's the production version).
  const isHearAndPick =
    question.type === "sight-word" && !shouldUseSpeechInput(question);

  // Effective display prompt: for hear-and-pick we hide the word.
  const effectivePrompt = isHearAndPick
    ? "Listen — pick the word"
    : question.prompt;

  // Effective audio prompt: PA atoms have one explicitly; sight-word
  // hear-and-pick mode needs to play the word; otherwise no auto-play.
  const effectiveAudioPrompt = isHearAndPick
    ? question.sound
    : question.audioPrompt;

  // 🔊 button replays whichever audio is the "puzzle" for this atom.
  const replayText = effectiveAudioPrompt || question.sound;
  const replayLabel = effectiveAudioPrompt ? "🔊 Hear again" : "🔊 Hear it";
  const soundButton =
    canSpeak && replayText
      ? `<button type="button" class="sound-btn" id="sound-btn" aria-label="Hear sound">${replayLabel}</button>`
      : "";

  // SPEECH-FIRST: render the mic UI when speech is available AND the
  // atom type is production-style. The student can flip to multiple-
  // choice via the toggle link if ASR keeps mishearing them.
  const useSpeech = shouldUseSpeechInput(question);

  const instruction = useSpeech
    ? `<div class="instruction">${instructionForSpeech(question)}</div>`
    : "";

  const answerArea = useSpeech
    ? `
      <div class="speak-area">
        <button type="button" class="mic-btn" id="mic-btn">🎤 Tap and speak</button>
        <div class="heard" id="heard"></div>
      </div>
    `
    : `<div class="choices" id="choices"></div>`;

  // The toggle is only shown when both modes are actually possible —
  // i.e. the atom has both `choices` AND speech is supported.
  const canToggle = SUPPORTS_SPEECH && Array.isArray(question.choices);
  const toggleLink = canToggle
    ? `<button type="button" class="link-btn" id="input-mode-toggle">
         ${useSpeech ? "Use buttons instead" : "Use voice instead"}
       </button>`
    : "";

  const progressLabel = isDiagnostic
    ? `Diagnostic ${answeredIds.size + 1} of ${effectiveQuizLength()}`
    : `Question ${answeredIds.size + 1} of ${effectiveQuizLength()}`;

  // Pick the right prompt-size class:
  //   long text → smaller font so it doesn't wrap awkwardly
  //   picture-word (emoji) → extra-large font for visual impact
  //   everything else → default 96px
  let promptClass = "prompt";
  if (question.type === "picture-word") {
    promptClass = "prompt prompt-picture";
  } else if (effectivePrompt && effectivePrompt.length > 12) {
    promptClass = "prompt prompt-small";
  }

  app.innerHTML = `
    ${topBarHTML()}
    <div class="progress">
      ${progressLabel}
      <span class="level-pill">Level ${currentDifficulty}</span>
    </div>
    <div class="category-tag">${question.category}</div>
    <div class="${promptClass}">${effectivePrompt}</div>
    ${instruction}
    ${soundButton}
    ${answerArea}
    ${toggleLink}
    <div class="feedback" id="feedback"></div>
  `;

  // Wire the input area based on the selected mode.
  if (useSpeech) {
    wireSpeakQuestion(question);
  } else {
    const choicesEl = document.getElementById("choices");
    question.choices.forEach((choice) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.textContent = choice;
      btn.addEventListener("click", () => handleAnswer(choice, question));
      choicesEl.appendChild(btn);
    });
  }

  // Wire the 🔊 button (same for both modes). For PA atoms and the
  // sight-word "hear and pick" mode, this replays the audio puzzle;
  // for everything else it plays the sound hint.
  const soundBtn = document.getElementById("sound-btn");
  if (soundBtn) {
    soundBtn.addEventListener("click", () =>
      playSound(replayText, question.category)
    );
  }

  // Auto-play the audio prompt for atoms that have one (PA atoms +
  // sight-word hear-and-pick) after a brief delay so the page has
  // rendered and any prior TTS has settled.
  if (effectiveAudioPrompt) {
    setTimeout(() => playSound(effectiveAudioPrompt, question.category), 250);
  }

  // Wire the input-mode toggle. Persist preference + re-render this
  // question in the new mode (no penalty for switching mid-question
  // because we haven't recorded an answer yet).
  const toggleBtn = document.getElementById("input-mode-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      inputModePreference = useSpeech ? "mc" : "speech";
      writeInputMode(inputModePreference);
      renderQuestion(question);
    });
  }
}

function handleAnswer(choice, question) {
  if (answered) return;
  answered = true;

  const timeMs = Date.now() - questionStart;
  const isCorrect = choice === question.answer;
  const verdict = classifyAnswer(question, isCorrect, timeMs);

  results.push({
    category: question.category,
    difficulty: question.difficulty,
    atomId: question.id,
    atomType: question.type,
    targetLatencyMs: question.targetLatencyMs,
    prompt: question.prompt,
    chosen: choice,
    answer: question.answer,
    correct: isCorrect,
    verdict,            // mastered | accurate | wrong
    timeMs,
  });

  // Mark this question as used so the adaptive selector won't pick it again.
  answeredIds.add(currentQuestionId);

  // Persist the attempt to per-student mastery state (no-op for guests).
  recordAttempt(question.id, verdict, timeMs);

  // Two-axis difficulty adjustment: ONLY mastered (correct + fast)
  // bumps up. "Accurate-but-slow" stays at the same level — the
  // student knows it but isn't automatic yet, so don't pile harder
  // material on top.
  if (verdict === "mastered") {
    currentDifficulty = Math.min(MAX_DIFFICULTY, currentDifficulty + 1);
  } else if (verdict === "wrong") {
    currentDifficulty = Math.max(MIN_DIFFICULTY, currentDifficulty - 1);
  }
  // verdict === "accurate" → leave currentDifficulty unchanged
  if (currentDifficulty > maxDifficulty) maxDifficulty = currentDifficulty;

  document.querySelectorAll(".choice").forEach((btn) => {
    btn.disabled = true;
    if (btn.textContent === question.answer) btn.classList.add("correct");
    else if (btn.textContent === choice && !isCorrect) btn.classList.add("wrong");
  });

  const feedback = document.getElementById("feedback");
  if (verdict === "mastered") {
    feedback.textContent = "Mastered!";
    feedback.className = "feedback good";
  } else if (verdict === "accurate") {
    feedback.textContent = "Correct — try to be faster.";
    feedback.className = "feedback good";
  } else {
    feedback.textContent = `The answer is ${question.answer}.`;
    feedback.className = "feedback bad";
    if (question.sound) playSound(question.sound, question.category);
  }

  appendNextButton();
}

// Add the "Next" / "See results" button below the current screen.
// Used by both choice questions and speak questions after they're answered.
function appendNextButton() {
  const isLast =
    answeredIds.size >= effectiveQuizLength() ||
    answeredIds.size >= filteredPoolLength();
  const nextBtn = document.createElement("button");
  nextBtn.className = "primary-btn next-btn";
  nextBtn.textContent = isLast ? "See results" : "Next";
  nextBtn.addEventListener("click", render);
  app.appendChild(nextBtn);
}

// ============================================================
// SPEECH RECOGNITION — for type:"speak" questions
// ============================================================

// Wire the mic button: tap → start listening → recognise → check.
function wireSpeakQuestion(question) {
  const micBtn = document.getElementById("mic-btn");
  if (!micBtn) return;
  micBtn.addEventListener("click", () => startListening(question, micBtn));
}

function startListening(question, micBtn) {
  if (answered) return;
  if (!SUPPORTS_SPEECH) {
    document.getElementById("heard").textContent =
      "Speech recognition isn't supported in this browser.";
    return;
  }

  const rec = new SR();
  rec.lang = "en-US";
  rec.maxAlternatives = 5;   // get the top 5 guesses, not just 1
  rec.continuous = false;
  rec.interimResults = false;

  micBtn.disabled = true;
  micBtn.classList.add("mic-listening");
  micBtn.textContent = "🎙️ Listening…";
  const heardEl = document.getElementById("heard");
  if (heardEl) heardEl.textContent = "";

  rec.onresult = (e) => {
    const alts = [];
    for (let i = 0; i < e.results[0].length; i++) {
      alts.push(e.results[0][i].transcript);
    }
    handleSpeechResult(question, alts, micBtn);
  };

  rec.onerror = (e) => {
    micBtn.disabled = false;
    micBtn.classList.remove("mic-listening");
    micBtn.textContent = "🎤 Try again";
    const msg =
      e.error === "not-allowed"
        ? "Microphone permission was denied — allow it in your browser settings."
        : e.error === "no-speech"
        ? "I didn't hear anything — tap and try again."
        : "Couldn't capture audio — tap to try again.";
    if (heardEl) heardEl.textContent = msg;
  };

  rec.onend = () => {
    if (!answered) {
      micBtn.disabled = false;
      micBtn.classList.remove("mic-listening");
      // Don't change the button text here — onresult/onerror already did.
    }
  };

  try {
    rec.start();
  } catch (e) {
    micBtn.disabled = false;
    micBtn.classList.remove("mic-listening");
    micBtn.textContent = "🎤 Tap and speak";
    if (heardEl) heardEl.textContent = "Couldn't start the microphone.";
  }
}

// Compare the speech recognizer's transcriptions against the question's
// `accepted` list. Generous matcher: counts as correct if any
// transcription (or any single word inside one) matches any accepted form.
function isSpeechCorrect(alts, accepted) {
  const acc = new Set(accepted.map((s) => s.toLowerCase().trim()));
  return alts.some((alt) => {
    const trimmed = alt.toLowerCase().trim();
    if (acc.has(trimmed)) return true;
    return trimmed.split(/\s+/).some((w) => acc.has(w));
  });
}

function handleSpeechResult(question, alts, micBtn) {
  if (answered) return;
  answered = true;

  const heardEl = document.getElementById("heard");
  const heard = (alts[0] || "").trim() || "(nothing)";
  if (heardEl) heardEl.textContent = `Heard: "${heard}"`;

  const isCorrect = isSpeechCorrect(alts, question.accepted);
  const timeMs = Date.now() - questionStart;
  const verdict = classifyAnswer(question, isCorrect, timeMs);

  results.push({
    category: question.category,
    difficulty: question.difficulty,
    atomId: question.id,
    atomType: question.type,
    targetLatencyMs: question.targetLatencyMs,
    prompt: question.prompt,
    chosen: heard,
    answer: question.answer,
    correct: isCorrect,
    verdict,
    timeMs,
  });

  answeredIds.add(currentQuestionId);

  // Persist the attempt to per-student mastery state (no-op for guests).
  recordAttempt(question.id, verdict, timeMs);

  // Same two-axis logic as multiple-choice answers.
  if (verdict === "mastered") {
    currentDifficulty = Math.min(MAX_DIFFICULTY, currentDifficulty + 1);
  } else if (verdict === "wrong") {
    currentDifficulty = Math.max(MIN_DIFFICULTY, currentDifficulty - 1);
  }
  if (currentDifficulty > maxDifficulty) maxDifficulty = currentDifficulty;

  micBtn.disabled = true;
  micBtn.classList.remove("mic-listening");
  micBtn.textContent = isCorrect ? "✓ Got it" : "🎤";

  const feedback = document.getElementById("feedback");
  if (verdict === "mastered") {
    feedback.textContent = "Mastered!";
    feedback.className = "feedback good";
  } else if (verdict === "accurate") {
    feedback.textContent = "Correct — try to be faster.";
    feedback.className = "feedback good";
  } else {
    feedback.textContent = `Try saying: "${question.answer}"`;
    feedback.className = "feedback bad";
    if (question.sound) playSound(question.sound, question.category);
  }

  appendNextButton();
}

// ============================================================
// DASHBOARD — same shape as math facts summary
// ============================================================
function renderDashboard() {
  const total = results.length;
  const correctCount  = results.filter((r) => r.correct).length;
  const masteredCount = results.filter((r) => r.verdict === "mastered").length;
  const accurateCount = results.filter((r) => r.verdict === "accurate").length;

  // Record this session once, the first time the dashboard renders
  // for this quiz. (We use a ref-style flag on the results array so
  // re-rendering the dashboard doesn't double-write.)
  if (!results._sessionRecorded && total > 0 && currentStudent && !isGuest) {
    results._sessionRecorded = true;
    const totalTimeMsLocal = results.reduce((s, r) => s + r.timeMs, 0);
    const avgLatencyMsLocal = total > 0 ? Math.round(totalTimeMsLocal / total) : 0;
    recordSession({
      studentId: currentStudent.id,
      durationSec: Math.round((Date.now() - quizStart) / 1000),
      totalAttempts: total,
      correctCount,
      masteredCount,
      avgLatencyMs: avgLatencyMsLocal,
      wasDiagnostic: isDiagnostic,
      strand: quizFilter,
    }).then(() => {
      // Refresh today's cached stats so home rings reflect this quiz.
      getTodayStats(currentStudent.id).then((s) => {
        todayStats = s;
      });
    });
  }

  // Two-axis breakdown for the rings:
  //   accuracy = anything correct / total          (Phase 1: first axis)
  //   speed    = mastered / total                  (Phase 1: second axis)
  //   effort   = how much of the quiz they did
  const accuracy = total > 0 ? correctCount / total : 0;
  const speed    = total > 0 ? masteredCount / total : 0;
  const effort   = total > 0 ? total / effectiveQuizLength() : 0;

  const totalTimeMs = results.reduce((s, r) => s + r.timeMs, 0);
  const avgSec = total > 0 ? (totalTimeMs / total / 1000).toFixed(1) : "0.0";
  const durationSec = Math.round((Date.now() - quizStart) / 1000);
  const greeting = isDiagnostic
    ? "Diagnostic complete — let's get started!"
    : pickGreeting(accuracy, total);
  const lifetimeMastered = isGuest ? null : masteredAtomCount();

  app.innerHTML = `
    ${topBarHTML()}

    <div class="warm-greeting">${greeting}</div>

    <div class="rings-wrap">
      ${ringsSvg(effort, accuracy, speed, 180, 14, 5)}
      <div class="rings-center">
        <div class="rings-xp">${masteredCount}/${total}</div>
        <div class="rings-label">Mastered</div>
      </div>
    </div>

    <div class="rings-legend">
      <div class="legend-item"><span class="dot" style="background:#fa3e3e"></span>Effort</div>
      <div class="legend-item"><span class="dot" style="background:#9aff00"></span>Accuracy</div>
      <div class="legend-item"><span class="dot" style="background:#3bc1f3"></span>Mastery</div>
    </div>

    <div class="summary-line">
      ${isDiagnostic ? "Initial assessment" : "Reading practice"} · ${fmtTime(durationSec)} · top level ${maxDifficulty}${
        lifetimeMastered != null
          ? ` · ${lifetimeMastered} atom${lifetimeMastered === 1 ? "" : "s"} mastered overall`
          : ""
      }
    </div>

    <div class="stat-grid">
      <div>
        <div class="stat-num">${masteredCount}</div>
        <div class="stat-label">Mastered</div>
      </div>
      <div>
        <div class="stat-num">${accurateCount}</div>
        <div class="stat-label">Correct, slow</div>
      </div>
      <div>
        <div class="stat-num">${avgSec}s</div>
        <div class="stat-label">Avg time</div>
      </div>
    </div>

    <div class="summary-actions">
      <button class="primary-btn" id="try-again">Try again</button>
      <button class="secondary-btn" id="done">Done</button>
    </div>
  `;

  // "Try again" → another quiz of the same strand (or all if no filter).
  // "Done" → back to home so the student can pick something else.
  document.getElementById("try-again").addEventListener("click", restartQuiz);
  document.getElementById("done").addEventListener("click", backToHome);
}

function restartQuiz() {
  // After the diagnostic completes, mastery rows exist for the student,
  // so the next quiz drops to normal length + mastery-weighted
  // selection. Guests never get the diagnostic.
  isDiagnostic = !isGuest && !hasAnyMastery();
  screen = "quiz";
  resetQuiz();
  render();
}

// ============================================================
// HELPERS
// ============================================================

// Pick the best available TTS voice. Browser default is often a
// generic robotic voice — premium voices on macOS (Samantha, Karen,
// Ava) and Google's en-US voice on Chrome handle phonics noticeably
// better. Cached after first lookup since the voice list is static.
let cachedVoice = undefined; // undefined = not looked up yet, null = none
function pickVoice() {
  if (cachedVoice !== undefined) return cachedVoice;
  if (typeof window.speechSynthesis === "undefined") {
    cachedVoice = null;
    return null;
  }
  const voices = window.speechSynthesis.getVoices() || [];
  if (voices.length === 0) return null; // not loaded yet — try next call

  const preferences = [
    "Samantha", "Ava", "Karen", "Allison",   // macOS premium en-US
    "Google US English",                      // Chrome
    "Microsoft Aria Online (Natural) - English (United States)",
    "Microsoft Jenny Online (Natural) - English (United States)",
  ];
  for (const name of preferences) {
    const v = voices.find((x) => x.name === name);
    if (v) { cachedVoice = v; return v; }
  }
  // Fall back to any en-US voice, preferring local (faster + usually better).
  cachedVoice = voices.find((v) => v.lang === "en-US" && v.localService)
             || voices.find((v) => v.lang === "en-US")
             || null;
  return cachedVoice;
}
// Re-pick if the voice list changes (some browsers populate async).
if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    cachedVoice = undefined;
  });
}

// Speak some text using the browser's built-in speech synthesis.
// Quietly does nothing in browsers without it. Cancels any in-flight
// utterance first so taps feel responsive.
//
// `category` lets us pick a sensible rate:
//   - Sight words & Decoding speak real English words → near-normal rate
//     (0.75) so they sound like natural speech, not robotic.
//   - Letter sounds & Digraphs are phonetic stretches like "sssss" or
//     "tuh" → very slow rate (0.4) so the engine articulates each
//     character rather than chopping it.
function playSound(text, category) {
  if (typeof window.speechSynthesis === "undefined") return;
  if (!text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const isWord = category === "Sight words" || category === "Decoding"
              || category === "Picture Words" || category === "Vocabulary";
  utter.rate = isWord ? 0.85 : 0.5;
  utter.pitch = 1.0;
  utter.volume = 1.0;
  utter.lang = "en-US";
  const v = pickVoice();
  if (v) utter.voice = v;
  window.speechSynthesis.speak(utter);
}

function ringsSvg(effort, accuracy, speed, size, stroke, gap) {
  const cx = size / 2;
  const cy = size / 2;
  const rings = [
    { v: effort,   c: "#fa3e3e" },
    { v: accuracy, c: "#9aff00" },
    { v: speed,    c: "#3bc1f3" },
  ];
  const ringElements = rings
    .map((r, i) => {
      const radius = size / 2 - stroke / 2 - i * (stroke + gap);
      if (radius <= 0) return "";
      const circumference = 2 * Math.PI * radius;
      const value = Math.min(1, Math.max(0, r.v));
      const dash = circumference * value;
      const trackColor = hexToRgba(r.c, 0.18);
      return `
        <g transform="rotate(-90 ${cx} ${cy})">
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none"
                  stroke="${trackColor}" stroke-width="${stroke}" />
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none"
                  stroke="${r.c}" stroke-width="${stroke}"
                  stroke-linecap="round"
                  stroke-dasharray="${dash} ${circumference}" />
        </g>
      `;
    })
    .join("");
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      ${ringElements}
    </svg>
  `;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fmtTime(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickGreeting(accuracy, total) {
  if (accuracy >= 0.95 && total >= 8) return "Outstanding work.";
  if (accuracy >= 0.85) return "Great session.";
  if (accuracy >= 0.7)  return "Solid effort.";
  if (accuracy >= 0.5)  return "Nice start.";
  return "Keep practicing.";
}

// ----- Boot -----
boot();
