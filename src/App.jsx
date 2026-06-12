import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";
import * as engine from "./engine";
import * as storage from "./storage";
import { Rings, RingsLegend } from "./Rings";
import { useAuth, signOut } from "./auth";
import { supabase } from "./supabase";
import { Login } from "./Login";
import { StudentPicker } from "./StudentPicker";

const CURRENT_STUDENT_KEY = "vpa-current-student-id";

// ============================================================
// ROOT — auth gate + student selection
// ============================================================
export default function App() {
  const { session, loading: authLoading } = useAuth();
  const [currentStudent, setCurrentStudent] = useState(null);
  const [studentResolved, setStudentResolved] = useState(false);

  // When auth changes: try to restore the previously-selected student
  useEffect(() => {
    let mounted = true;

    if (!session) {
      setCurrentStudent(null);
      setStudentResolved(false);
      return;
    }

    async function resolve() {
      const savedId = localStorage.getItem(CURRENT_STUDENT_KEY);
      if (!savedId) {
        if (mounted) setStudentResolved(true);
        return;
      }
      const { data, error } = await supabase
        .from("students")
        .select("*")
        .eq("id", savedId)
        .maybeSingle();
      if (!mounted) return;
      if (!error && data) {
        setCurrentStudent(data);
      } else {
        localStorage.removeItem(CURRENT_STUDENT_KEY);
      }
      setStudentResolved(true);
    }
    resolve();

    return () => {
      mounted = false;
    };
  }, [session]);

  function selectStudent(s) {
    localStorage.setItem(CURRENT_STUDENT_KEY, s.id);
    setCurrentStudent(s);
  }

  async function handleSignOut() {
    localStorage.removeItem(CURRENT_STUDENT_KEY);
    setCurrentStudent(null);
    await signOut();
  }

  function switchStudent() {
    localStorage.removeItem(CURRENT_STUDENT_KEY);
    setCurrentStudent(null);
  }

  if (authLoading) return <LoadingCard label="Loading…" />;
  if (!session) return <Login />;
  if (!studentResolved) return <LoadingCard label="Loading…" />;
  if (!currentStudent) {
    return <StudentPicker session={session} onSelect={selectStudent} />;
  }

  return (
    <MathFactsApp
      student={currentStudent}
      onSignOut={handleSignOut}
      onSwitchStudent={switchStudent}
    />
  );
}

function LoadingCard({ label = "Loading…" }) {
  return (
    <main className="app">
      <div className="card auth-card">
        <div className="auth-loading">{label}</div>
      </div>
    </main>
  );
}

// ============================================================
// MATH FACTS APP — student-aware shell wrapping the screen routing
// ============================================================
function MathFactsApp({ student, onSignOut, onSwitchStudent }) {
  const [persisted, setPersisted] = useState(null);
  const [screen, setScreen] = useState("home"); // home | prestart | probe | session | summary
  const [activeOp, setActiveOp] = useState(null);
  const [lastSummary, setLastSummary] = useState(null);

  // Async-load persisted state when the active student changes
  useEffect(() => {
    let mounted = true;
    setPersisted(null);
    storage.loadStudentState(student.id).then((state) => {
      if (mounted) setPersisted(state);
    });
    return () => {
      mounted = false;
    };
  }, [student.id]);

  function startSession(op) {
    setActiveOp(op);
    // Fresh op (zero attempts anywhere) → offer the Fast Start
    // placement probe before dropping the student at strand 1.
    if (engine.isFreshOp(persisted, op)) {
      setScreen("prestart");
    } else {
      setScreen("session");
    }
  }

  function finishSession(summary, factsAfter, levelAfter) {
    const next = storage.recordSession(
      student.id,
      persisted,
      summary,
      factsAfter,
      levelAfter
    );
    setPersisted(next);
    setLastSummary(summary);
    setScreen("summary");
  }

  function backToHome() {
    setScreen("home");
    setActiveOp(null);
    setLastSummary(null);
  }

  if (!persisted) return <LoadingCard label="Loading your progress…" />;

  if (screen === "prestart") {
    return (
      <FastStartChoice
        op={activeOp}
        onProbe={() => setScreen("probe")}
        onScratch={() => setScreen("session")}
        onBack={backToHome}
      />
    );
  }

  if (screen === "probe") {
    return (
      <ProbeSession op={activeOp} persisted={persisted} onComplete={finishSession} />
    );
  }

  if (screen === "session") {
    return (
      <Session op={activeOp} persisted={persisted} onComplete={finishSession} />
    );
  }

  if (screen === "summary" && lastSummary) {
    return (
      <Summary
        summary={lastSummary}
        persisted={persisted}
        onContinue={() => startSession(lastSummary.op)}
        onDone={backToHome}
      />
    );
  }

  return (
    <Home
      persisted={persisted}
      student={student}
      onStart={startSession}
      onSignOut={onSignOut}
      onSwitchStudent={onSwitchStudent}
    />
  );
}

// ============================================================
// StrandStrip — per-op visible progression strip
//
// Renders one chip per strand in unlock order. Each chip is filled
// (complete), partial (active with progress fill), or hollow (locked).
// The active strand chip is highlighted. Shows up under each op card
// on the Home screen so the kid can SEE that the curriculum is a
// sequence, not just a single big pool.
// ============================================================
function StrandStrip({ strands }) {
  return (
    <div className="strand-strip" title={strandStripTitle(strands)}>
      {strands.map((s) => {
        const cls =
          s.status === "complete" ? "strand-chip complete"
          : s.status === "active" ? "strand-chip active"
          : "strand-chip locked";
        const fill = s.total > 0 ? Math.round((s.masteredCount / s.total) * 100) : 0;
        return (
          <div key={s.id} className={cls} title={`${s.label} — ${s.masteredCount}/${s.total}`}>
            <div className="strand-chip-fill" style={{ width: `${fill}%` }} />
          </div>
        );
      })}
    </div>
  );
}

function strandStripTitle(strands) {
  const done = strands.filter((s) => s.status === "complete").length;
  const total = strands.length;
  return `Strand progress: ${done} / ${total}`;
}

// ============================================================
// HOME — today's rings + operation picker
// ============================================================
function Home({ persisted, student, onStart, onSignOut, onSwitchStudent }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const today = storage.getTodayHistory(persisted);
  const todayActiveSec = today.totalActiveSec || 0;
  const todayXp = engine.xpFromActiveSec(todayActiveSec);

  const totalAttempts = today.sessions.reduce((s, x) => s + (x.attempts || 0), 0);
  const totalCorrect  = today.sessions.reduce((s, x) => s + (x.correct  || 0), 0);
  const totalFast     = today.sessions.reduce((s, x) => s + (x.fastCount|| 0), 0);
  const accuracy = totalAttempts > 0 ? totalCorrect / totalAttempts : 0;
  const speed    = totalCorrect  > 0 ? totalFast / totalCorrect    : 0;

  const streak = storage.dayStreak(persisted);
  const goalHit = todayXp >= engine.DAILY_GOAL_XP;
  const remainingMin = Math.max(0, Math.ceil(engine.DAILY_GOAL_XP - todayXp));
  const rec = engine.recommendedOp(persisted);
  const recText = engine.recommendationText(rec, persisted);

  // Aggregate mastery gained today across all operations
  const totalMasteredToday = Object.values(engine.OPERATIONS).reduce(
    (sum, op) => sum + engine.masterySummary(persisted, op.key).gainedToday,
    0
  );
  const summaryBits = [
    streak > 0 && `${streak}-day streak`,
    totalMasteredToday > 0 && `+${totalMasteredToday} mastered today`,
  ].filter(Boolean);

  return (
    <main className="app">
      <div className="card home">
        <div className="home-topbar">
          <span className="home-student">{student?.display_name || "Student"}</span>
          <div className="home-menu-wrap">
            <button
              type="button"
              className="home-menu-btn"
              aria-label="Account menu"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="home-menu">
                <button
                  type="button"
                  className="home-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onSwitchStudent && onSwitchStudent();
                  }}
                >
                  Switch student
                </button>
                <button
                  type="button"
                  className="home-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onSignOut && onSignOut();
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="eyebrow">Today's plan</div>
        <div className="plan-line">
          {goalHit
            ? "Goal complete — bonus rep?"
            : `${remainingMin} min · ${recText}`}
        </div>

        <div className="rings-wrap">
          <Rings
            effort={Math.min(todayXp / engine.DAILY_GOAL_XP, 1)}
            accuracy={accuracy}
            speed={speed}
            size={220}
            stroke={18}
            gap={6}
          />
          <div className="rings-center">
            <div className="rings-xp">{todayXp.toFixed(1)}</div>
            <div className="rings-label">of {engine.DAILY_GOAL_XP} XP</div>
          </div>
        </div>

        <RingsLegend />

        {summaryBits.length > 0 && (
          <div className="streak-line">{summaryBits.join(" · ")}</div>
        )}

        <div className="op-grid">
          {Object.values(engine.OPERATIONS).map((op) => {
            const locked = !engine.isOpUnlocked(op.key, persisted);
            const isRecommended = op.key === rec.op && !goalHit && !locked;

            // Strand-aware metadata. Falls back to old summary if the
            // strand data isn't loaded yet (shouldn't happen, but
            // defensive).
            const strands = !locked
              ? engine.strandStatuses(persisted.progress[op.key]?.facts || {}, op.key)
              : [];
            const activeStrand = strands.find((s) => s.status === "active");
            const completedCount = strands.filter((s) => s.status === "complete").length;
            const totalStrands = strands.length;

            let meta, subMeta;
            if (locked && op.key === "division") {
              const p = engine.divisionUnlockProgress(persisted);
              meta = "Locked";
              subMeta = `Master ${p.needed} × facts (${p.current}/${p.needed})`;
            } else if (locked) {
              meta = "Locked";
              subMeta = null;
            } else if (activeStrand) {
              meta = activeStrand.label;
              subMeta = `${activeStrand.masteredCount} / ${activeStrand.total} · strand ${completedCount + 1} of ${totalStrands}`;
            } else {
              // Every strand complete!
              meta = "All strands mastered";
              subMeta = "Bonus practice keeps facts sharp";
            }

            return (
              <button
                key={op.key}
                className={`op-card${locked ? " op-card-locked" : ""}${isRecommended ? " op-card-recommended" : ""}`}
                onClick={locked ? undefined : () => onStart(op.key)}
                disabled={locked}
              >
                <span className="op-symbol">{op.symbol}</span>
                <span className="op-label">{op.label}</span>
                <span className="op-meta">{meta}</span>
                {subMeta && <span className="op-submeta">{subMeta}</span>}
                {!locked && strands.length > 0 && (
                  <StrandStrip strands={strands} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </main>
  );
}

// ============================================================
// FAST START — choice screen + placement probe (2026-06-12)
// ============================================================
function FastStartChoice({ op, onProbe, onScratch, onBack }) {
  const operation = engine.OPERATIONS[op];
  return (
    <main className="app">
      <div className="card session-card">
        <div className="session-header">
          <button className="back-btn" onClick={onBack} aria-label="Back">
            ←
          </button>
          <span className="op-name">{operation.label}</span>
          <span className="meta" />
        </div>
        <div className="warm-greeting">Already know some {operation.label.toLowerCase()}?</div>
        <p className="summary-line" style={{ margin: "12px 0 24px" }}>
          Take a 2-minute Fast Start check. Anything you can already answer
          quickly gets skipped, so you start right at your level.
        </p>
        <div className="summary-actions">
          <button className="primary-btn" onClick={onProbe}>
            Fast Start check
          </button>
          <button className="secondary-btn" onClick={onScratch}>
            Start from the beginning
          </button>
        </div>
      </div>
    </main>
  );
}

// Probe loop: 2 facts per strand, in unlock order. A strand passes if
// every probed fact is correct within the op's `slow` threshold. The
// first miss (or slow answer) ends the probe — that's the placement
// point. Passed strands get seeded as `known` via applyProbeResults.
function ProbeSession({ op, persisted, onComplete }) {
  const operation = engine.OPERATIONS[op];
  const startProg = persisted.progress[op] || engine.initialProgress(op);

  const planRef = useRef(null);
  if (!planRef.current) planRef.current = engine.buildProbePlan(startProg.facts, op);
  const plan = planRef.current;

  const [strandIdx, setStrandIdx] = useState(0);
  const [factIdx, setFactIdx] = useState(0);
  const [input, setInput] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(false);

  const statsRef = useRef({
    attempts: 0,
    correct: 0,
    fastCount: 0,
    latencies: [],
    activeSec: 0,
    passed: [], // strand ids that fully passed
  });
  const startRef = useRef(Date.now());
  const inputRef = useRef(null);

  const strand = plan[strandIdx];
  const fact = strand?.facts[factIdx];

  useEffect(() => {
    startRef.current = Date.now();
    if (inputRef.current) inputRef.current.focus();
  }, [strandIdx, factIdx]);

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [done]);

  // Time cap — score what we have
  useEffect(() => {
    if (!done && elapsed >= engine.PROBE_TIME_CAP) finishProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  function finishProbe() {
    if (done) return;
    setDone(true);
    const s = statsRef.current;
    const today = undefined; // engine defaults to today
    const newFacts = engine.applyProbeResults(startProg.facts, s.passed, today);
    const avgLatency =
      s.latencies.length > 0
        ? Math.round(s.latencies.reduce((a, x) => a + x, 0) / s.latencies.length)
        : 0;
    const placed = engine.activeStrandId(newFacts, op);
    const placedDef = placed ? engine.strandById?.(placed) : null;
    onComplete(
      {
        op,
        activeSec: s.activeSec,
        durationSec: elapsed,
        attempts: s.attempts,
        correct: s.correct,
        fastCount: s.fastCount,
        avgLatencyMs: avgLatency,
        accuracy: s.attempts > 0 ? s.correct / s.attempts : 0,
        speed: s.correct > 0 ? s.fastCount / s.correct : 0,
        xp: engine.xpFromActiveSec(s.activeSec),
        newlyAutomaticIds: [],
        newlyAutomaticCount: 0,
        probe: true,
        passedStrandCount: s.passed.length,
        placedStrandLabel: placedDef?.label || null,
      },
      newFacts,
      startProg.currentLevel,
    );
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (input === "" || done || !fact) return;

    const latency = Date.now() - startRef.current;
    const numInput = Number(input);
    const correctAns =
      Number.isFinite(numInput) && Math.abs(numInput - fact.answer) < 0.001;
    const withinSlow = latency <= engine.THRESHOLDS[op].slow;
    const pass = correctAns && withinSlow;

    const s = statsRef.current;
    s.attempts += 1;
    if (correctAns) {
      s.correct += 1;
      s.latencies.push(latency);
      if (latency <= engine.THRESHOLDS[op].fast) s.fastCount += 1;
    }
    s.activeSec += Math.min(latency / 1000, engine.PROBLEM_TIME_CAP);
    setInput("");

    if (!pass) {
      // Placement found — this strand is the student's frontier.
      finishProbe();
      return;
    }

    if (factIdx + 1 < strand.facts.length) {
      setFactIdx(factIdx + 1);
      return;
    }

    // Strand fully passed
    s.passed.push(strand.strandId);
    if (strandIdx + 1 < plan.length) {
      setStrandIdx(strandIdx + 1);
      setFactIdx(0);
    } else {
      finishProbe();
    }
  }

  if (!fact) return null;

  return (
    <main className="app">
      <div className="card session-card">
        <div className="session-header">
          <button
            className="back-btn"
            onClick={finishProbe}
            aria-label="End check"
          >
            ←
          </button>
          <span className="op-name">Fast Start · {operation.label}</span>
          <span className="meta meta-time">{engine.fmtTime(elapsed)}</span>
        </div>

        <div className="eyebrow" style={{ textAlign: "center", marginTop: 8 }}>
          Checkpoint {strandIdx + 1} of {plan.length}
        </div>

        <h1 className="problem">
          {fact.displayText || `${fact.a} ${operation.symbol} ${fact.b}`}
        </h1>

        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputMode={op === "numbers" ? "decimal" : "numeric"}
            className="answer-input"
            disabled={done}
          />
        </form>

        <div className="feedback"> </div>
      </div>
    </main>
  );
}

// ============================================================
// SESSION — the training loop
// ============================================================
function Session({ op, persisted, onComplete }) {
  const operation = engine.OPERATIONS[op];
  const startProg = persisted.progress[op] || engine.initialProgress(op);

  const [facts, setFacts] = useState(startProg.facts);
  const [currentLevel, setCurrentLevel] = useState(startProg.currentLevel);
  const [currentId, setCurrentId] = useState(() =>
    engine.selectNextFact(startProg.facts, null, op).id
  );
  // Phase 4 — missing-operand presentation rotation. A fact in `known`
  // or `automatic` state has a 1-in-3 chance of being presented as
  // "? + b = c" or "a + ? = c" instead of "a + b = ?". Adds variety
  // and forces deeper retrieval. Symbolic by default for un-mastered
  // facts so the student can build the standard form first.
  // Numbers facts always render their own displayText, regardless.
  const [currentPresentation, setCurrentPresentation] = useState(() =>
    pickPresentation(startProg.facts[currentId]),
  );
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");
  const [feedbackKind, setFeedbackKind] = useState("");
  const [unlockNotice, setUnlockNotice] = useState("");

  // Live session stats
  const [activeSec, setActiveSec] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [fastCount, setFastCount] = useState(0);
  const [latencies, setLatencies] = useState([]);
  const [done, setDone] = useState(false);
  const [currentHint, setCurrentHint] = useState(null); // structured hint object or null

  const automaticAtStartRef = useRef(
    new Set(
      Object.values(startProg.facts)
        .filter((f) => f.state === "automatic")
        .map((f) => f.id)
    )
  );
  // Tracks facts hinted this session — only one hint per fact per session
  const hintedRef = useRef(new Set());
  const startRef = useRef(Date.now());
  const inputRef = useRef(null);

  // Merge the session-local presentation into the fact object so
  // formatProblem and the answer-comparison logic can read it.
  // (We don't mutate the stored fact — the presentation is a per-
  // render choice, not persisted.)
  const fact = facts[currentId]
    ? { ...facts[currentId], presentation: currentPresentation }
    : null;

  useEffect(() => {
    startRef.current = Date.now();
    if (inputRef.current) inputRef.current.focus();
  }, [currentId]);

  // mm:ss timer
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [done]);

  // Auto-clear unlock toast
  useEffect(() => {
    if (!unlockNotice) return;
    const id = setTimeout(() => setUnlockNotice(""), 2400);
    return () => clearTimeout(id);
  }, [unlockNotice]);

  // Time cap
  useEffect(() => {
    if (!done && elapsed >= engine.SESSION_TIME_CAP) {
      finishNow(facts, currentLevel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  // Stable callback for HintCard to call when reveal is complete
  const handleHintDone = useCallback(() => {
    setCurrentHint(null);
    setInput("");
    startRef.current = Date.now();
    if (inputRef.current) inputRef.current.focus();
  }, []);

  function finishNow(latestFacts, latestLevel, fresh) {
    if (done) return;
    setDone(true);

    // Use freshly-computed values when called inline from handleSubmit;
    // fall back to React state when called from elsewhere (back button, time cap).
    const f = fresh || {
      activeSec,
      attempts,
      correct,
      fastCount,
      latencies,
      elapsed,
    };

    const newlyAutomaticIds = Object.values(latestFacts)
      .filter((x) => x.state === "automatic" && !automaticAtStartRef.current.has(x.id))
      .map((x) => x.id);
    const avgLatency =
      f.latencies.length > 0
        ? Math.round(f.latencies.reduce((s, x) => s + x, 0) / f.latencies.length)
        : 0;

    const summary = {
      op,
      activeSec: f.activeSec,
      durationSec: f.elapsed,
      attempts: f.attempts,
      correct: f.correct,
      fastCount: f.fastCount,
      avgLatencyMs: avgLatency,
      accuracy: f.attempts > 0 ? f.correct / f.attempts : 0,
      speed: f.correct > 0 ? f.fastCount / f.correct : 0,
      xp: engine.xpFromActiveSec(f.activeSec),
      newlyAutomaticIds,
      newlyAutomaticCount: newlyAutomaticIds.length,
    };
    onComplete(summary, latestFacts, latestLevel);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (input === "" || done) return;

    const latency = Date.now() - startRef.current;
    // Compute expected answer based on fact's presentation.
    //   symbolic     → answer = a OP b (= fact.answer)
    //   missing-a    → answer = a (the missing left operand)
    //   missing-b    → answer = b (the missing right operand)
    // For Numbers facts (which always have displayText), the
    // expected stays fact.answer.
    let expected = fact.answer;
    if (fact.presentation === "missing-a") expected = fact.a;
    else if (fact.presentation === "missing-b") expected = fact.b;
    // Decimal-tolerant compare so 0.25 vs "0.25" or rounding noise
    // doesn't false-fail. Tolerance is 0.001.
    const numInput = Number(input);
    const correctAns =
      Number.isFinite(numInput) && Math.abs(numInput - expected) < 0.001;
    const result = engine.classify(correctAns, latency, op);

    // Active-time accumulation, capped per problem to prevent idle gaming
    const activeAdd = Math.min(latency / 1000, engine.PROBLEM_TIME_CAP);
    const newActive = activeSec + activeAdd;

    const updated = engine.applyAttempt(fact, result, latency, op);
    const newFacts = { ...facts, [updated.id]: updated };

    const newAttempts = attempts + 1;
    const newCorrect  = correct + (correctAns ? 1 : 0);
    const newFast     = fastCount + (result === "fast" ? 1 : 0);

    setActiveSec(newActive);
    setAttempts(newAttempts);
    setCorrect(newCorrect);
    setFastCount(newFast);
    if (correctAns) setLatencies((arr) => [...arr, latency]);

    // Hint escalation: second consecutive miss on the same fact triggers a strategy hint,
    // and the SAME fact is re-shown so the student can apply it.
    const triggerHint =
      result === "wrong" &&
      updated.streakWrong >= 2 &&
      !hintedRef.current.has(updated.id);

    // Feedback
    if (result === "fast") {
      setFeedback("Automatic");
      setFeedbackKind("good");
    } else if (result === "slow") {
      setFeedback(engine.inFluencyMode(fact) ? "Correct, slow" : "Correct");
      setFeedbackKind(engine.inFluencyMode(fact) ? "ok" : "good");
    } else if (result === "tooSlow") {
      setFeedback(engine.inFluencyMode(fact) ? "Too slow" : "Correct");
      setFeedbackKind(engine.inFluencyMode(fact) ? "ok" : "good");
    } else if (triggerHint) {
      setCurrentHint(engine.hintFor(updated));
      setFeedback("");
      setFeedbackKind("");
      hintedRef.current.add(updated.id);
    } else {
      // Show the correct answer. For numbers facts and missing-operand
      // we just show "= <expected>" since the problem itself is the
      // displayText.
      setFeedback(
        fact.displayText
          ? `${fact.displayText} = ${expected}`
          : fact.presentation === "missing-a" || fact.presentation === "missing-b"
          ? `Answer: ${expected}`
          : `${formatProblem(fact, op)} = ${expected}`,
      );
      setFeedbackKind("bad");
    }

    // Strand-completion → unlock toast. Compare the active strand
    // before/after this attempt; if it changed, the previous strand
    // just completed and a new strand is now active.
    const prevActiveId = engine.activeStrandId(facts, op);
    const nextActiveId = engine.activeStrandId(newFacts, op);
    let newLevel = currentLevel;
    if (prevActiveId !== nextActiveId && nextActiveId) {
      const def = engine.strandById?.(nextActiveId);
      setUnlockNotice(def ? `Unlocked: ${def.label}` : "New strand unlocked");
    } else if (engine.shouldExpand(newFacts, currentLevel, op)) {
      // Legacy level-up path — kept harmless for any old data. With
      // strand-based selection currentLevel no longer drives the
      // fact pool, but bumping it keeps the storage shape stable.
      newLevel = currentLevel + 1;
      setCurrentLevel(newLevel);
    }

    setFacts(newFacts);

    // Session goal hit?
    const newXp = engine.xpFromActiveSec(newActive);
    if (newXp >= engine.SESSION_GOAL_XP || elapsed >= engine.SESSION_TIME_CAP) {
      finishNow(newFacts, newLevel, {
        activeSec: newActive,
        attempts: newAttempts,
        correct: newCorrect,
        fastCount: newFast,
        latencies: correctAns ? [...latencies, latency] : latencies,
        elapsed,
      });
      return;
    }

    // After a hint, leave the SAME fact on screen. The HintCard reveals the
    // strategy step-by-step; when its onDone fires (handleHintDone), input
    // re-enables and the timer restarts so the student can apply the strategy.
    if (triggerHint) {
      setInput("");
      return;
    }

    const next = engine.selectNextFact(newFacts, updated.id, op);
    setCurrentId(next.id);
    setCurrentPresentation(pickPresentation(newFacts[next.id]));
    setInput("");
  }

  const xp = engine.xpFromActiveSec(activeSec);
  const xpPct = Math.min(1, xp / engine.SESSION_GOAL_XP);
  const accuracyPct = attempts > 0 ? correct / attempts : 0;
  const speedPct = correct > 0 ? fastCount / correct : 0;

  return (
    <main className="app">
      <div className="card session-card">
        <div className="session-header">
          <button
            className="back-btn"
            onClick={() => finishNow(facts, currentLevel)}
            aria-label="End session"
          >
            ←
          </button>
          <span className="op-name">{operation.label}</span>
          <span className="meta meta-time">{engine.fmtTime(elapsed)}</span>
        </div>

        <div className="session-rings">
          <Rings
            effort={xpPct}
            accuracy={accuracyPct}
            speed={speedPct}
            size={120}
            stroke={10}
            gap={4}
          />
        </div>

        <h1 className="problem">{formatProblem(fact, op)}</h1>

        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputMode={op === "numbers" ? "decimal" : "numeric"}
            className="answer-input"
            disabled={done || currentHint !== null}
          />
        </form>

        {currentHint ? (
          <HintCard hint={currentHint} onDone={handleHintDone} />
        ) : (
          <div className={`feedback feedback-${feedbackKind}`}>
            {feedback || " "}
          </div>
        )}

        {unlockNotice && <div className="unlock-toast">{unlockNotice}</div>}
      </div>
    </main>
  );
}

// ============================================================
// HINT CARD — renders strategy + steps with timed reveal
// ============================================================
function HintCard({ hint, onDone }) {
  // Instant hints reveal everything at once; stepped hints reveal one at a time.
  const [revealedCount, setRevealedCount] = useState(
    hint.instant ? hint.steps.length : 0
  );
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;

    // Still revealing — schedule next step
    if (revealedCount < hint.steps.length) {
      const t = setTimeout(() => {
        setRevealedCount((c) => c + 1);
      }, hint.instant ? 0 : 800);
      return () => clearTimeout(t);
    }

    // All steps revealed — pause briefly, then signal done
    const t = setTimeout(() => {
      if (!doneRef.current) {
        doneRef.current = true;
        onDone();
      }
    }, hint.instant ? 1400 : 700);
    return () => clearTimeout(t);
  }, [revealedCount, hint, onDone]);

  function skip() {
    if (doneRef.current) return;
    setRevealedCount(hint.steps.length);
    // Effect will fire onDone after the post-reveal pause
  }

  const stepped = !hint.instant && revealedCount < hint.steps.length;

  return (
    <div className="hint-card">
      <div className="hint-strategy">{hint.strategy}</div>
      <div className="hint-steps">
        {hint.steps.map((step, i) => (
          <div
            key={i}
            className={`hint-step${i < revealedCount ? " revealed" : ""}`}
          >
            {step}
          </div>
        ))}
      </div>
      {stepped && (
        <button type="button" className="hint-skip" onClick={skip}>
          Got it
        </button>
      )}
    </div>
  );
}

// Phase 4 — decide how to present a fact.
//   - Numbers facts always render their displayText (no rotation).
//   - Facts in `known` or `automatic` state: 1-in-3 chance of being
//     shown as missing-operand. Equal chance of missing-a or missing-b.
//   - Everything else: symbolic.
// Pure function — call when picking a new fact for the screen.
function pickPresentation(fact) {
  if (!fact || fact.displayText) return "symbolic";
  if (fact.state !== "known" && fact.state !== "automatic") return "symbolic";
  if (Math.random() >= 1 / 3) return "symbolic";
  return Math.random() < 0.5 ? "missing-a" : "missing-b";
}

function formatProblem(fact, op) {
  // Phase 4: missing-operand presentations. Pure rendering — the
  // canonical answer is still fact.answer; only the display changes.
  // The presentation is decided in startSession() (see prepareFact).
  if (fact.displayText) {
    return fact.displayText;
  }
  const symbol = engine.OPERATIONS[op].symbol;
  if (fact.presentation === "missing-a") {
    return `? ${symbol} ${fact.b} = ${fact.answer}`;
  }
  if (fact.presentation === "missing-b") {
    return `${fact.a} ${symbol} ? = ${fact.answer}`;
  }
  return `${fact.a} ${symbol} ${fact.b}`;
}

// ============================================================
// SUMMARY — warm session recap
// ============================================================
function Summary({ summary, persisted, onContinue, onDone }) {
  const operation = engine.OPERATIONS[summary.op];

  // Day-over-day comparison: avg latency for the same operation
  const yest = persisted.history[storage.yesterdayKey()];
  let comparison = null;
  if (yest) {
    const yestSessions = yest.sessions.filter((s) => s.op === summary.op && s.avgLatencyMs > 0);
    if (yestSessions.length > 0 && summary.avgLatencyMs > 0) {
      const yestAvg = yestSessions.reduce((s, x) => s + x.avgLatencyMs, 0) / yestSessions.length;
      const pctChange = (yestAvg - summary.avgLatencyMs) / yestAvg;
      if (pctChange > 0.05) {
        comparison = { kind: "good", text: `${Math.round(pctChange * 100)}% faster than yesterday` };
      } else if (pctChange < -0.05) {
        comparison = { kind: "ok", text: `${Math.round(-pctChange * 100)}% slower than yesterday — keep training` };
      } else {
        comparison = { kind: "ok", text: "Steady with yesterday" };
      }
    }
  }

  const greeting = pickGreeting(summary);

  return (
    <main className="app summary-bg">
      <div className="card summary warm">
        <div className="warm-greeting">{greeting}</div>

        <div className="rings-wrap small">
          <Rings
            effort={Math.min(summary.xp / engine.SESSION_GOAL_XP, 1)}
            accuracy={summary.accuracy}
            speed={summary.speed}
            size={180}
            stroke={14}
            gap={5}
          />
          <div className="rings-center">
            <div className="rings-xp">{summary.xp.toFixed(1)}</div>
            <div className="rings-label">XP</div>
          </div>
        </div>

        <div className="summary-line">
          {summary.probe ? "Fast Start · " : ""}
          {operation.label} · {engine.fmtTime(summary.durationSec)}
        </div>

        {summary.probe && (
          <div className="comparison comparison-good">
            {summary.passedStrandCount > 0
              ? `Skipped ${summary.passedStrandCount} strand${summary.passedStrandCount === 1 ? "" : "s"} you already know${summary.placedStrandLabel ? ` — starting at ${summary.placedStrandLabel}` : ""}`
              : "Starting from the beginning — perfect place to build"}
          </div>
        )}

        {comparison && (
          <div className={`comparison comparison-${comparison.kind}`}>
            {comparison.text}
          </div>
        )}

        <div className="stat-grid">
          <div className="stat">
            <div className="stat-num">{Math.round(summary.accuracy * 100)}%</div>
            <div className="stat-label">Accuracy</div>
          </div>
          <div className="stat">
            <div className="stat-num">
              {summary.avgLatencyMs ? (summary.avgLatencyMs / 1000).toFixed(2) : "—"}s
            </div>
            <div className="stat-label">Avg speed</div>
          </div>
          <div className="stat">
            <div className="stat-num">{summary.newlyAutomaticCount}</div>
            <div className="stat-label">New automatic</div>
          </div>
        </div>

        <div className="summary-actions">
          <button className="primary-btn" onClick={onContinue}>
            Train more
          </button>
          <button className="secondary-btn" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </main>
  );
}

function pickGreeting(summary) {
  const goalHit = summary.xp >= engine.SESSION_GOAL_XP;
  if (goalHit && summary.accuracy >= 0.95) return "Outstanding work.";
  if (goalHit && summary.accuracy >= 0.85) return "Great session.";
  if (goalHit) return "Goal hit — solid effort.";
  if (summary.accuracy >= 0.9) return "Sharp focus today.";
  if (summary.attempts >= 10) return "Good reps in.";
  return "Nice start.";
}
