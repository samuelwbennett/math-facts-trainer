import { useState, useEffect } from "react";
import { supabase } from "./supabase";

export function StudentPicker({ session, onSelect }) {
  const [students, setStudents] = useState(null); // null = loading
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [grade, setGrade] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data, error: err } = await supabase
        .from("students")
        .select("*")
        .order("created_at", { ascending: true });
      if (!mounted) return;
      if (err) {
        setError(err.message);
        setStudents([]);
      } else {
        setStudents(data || []);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  // Auto-select if exactly one student exists
  useEffect(() => {
    if (students && students.length === 1) {
      onSelect(students[0]);
    }
  }, [students, onSelect]);

  async function createStudent(e) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError("");

    // Atomic RPC: creates the student row + guardian-student link in one
    // transaction (bypasses RLS via SECURITY DEFINER, but verifies the caller).
    const { data: student, error: rpcErr } = await supabase.rpc(
      "create_student_for_guardian",
      {
        p_name: name.trim(),
        p_grade: grade ? parseInt(grade, 10) : null,
      }
    );

    if (rpcErr) {
      setError(rpcErr.message);
      setCreating(false);
      return;
    }

    onSelect(student);
  }

  if (students === null) {
    return (
      <main className="app">
        <div className="card auth-card">
          <div className="auth-loading">Loading...</div>
        </div>
      </main>
    );
  }

  // No students yet — onboarding
  if (students.length === 0) {
    return (
      <main className="app">
        <div className="card auth-card">
          <div className="brand-mark">VPA</div>
          <h1 className="auth-title">Add a student</h1>
          <p className="auth-subtitle">
            Who's training? You can add more later.
          </p>
          <form onSubmit={createStudent}>
            <input
              type="text"
              placeholder="Student name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              className="auth-input"
            />
            <input
              type="number"
              placeholder="Grade (optional)"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              min="0"
              max="12"
              className="auth-input"
            />
            <button
              type="submit"
              className="primary-btn auth-submit"
              disabled={creating}
            >
              {creating ? "Creating..." : "Continue"}
            </button>
            {error && <div className="auth-error">{error}</div>}
          </form>
        </div>
      </main>
    );
  }

  // Exactly one — auto-select effect already fired; render nothing
  if (students.length === 1) return null;

  // Multiple — picker
  return (
    <main className="app">
      <div className="card auth-card">
        <div className="brand-mark">VPA</div>
        <h1 className="auth-title">Who's training?</h1>
        <div className="student-list">
          {students.map((s) => (
            <button
              key={s.id}
              type="button"
              className="student-card"
              onClick={() => onSelect(s)}
            >
              <span className="student-name">{s.display_name}</span>
              {s.grade_level != null && (
                <span className="student-grade">Grade {s.grade_level}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
