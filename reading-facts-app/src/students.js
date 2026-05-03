// Students module — load the list of VPA students for the current
// guardian, create new ones, and remember which student is "active"
// across page reloads.
//
// Uses the SAME `students` table and the SAME RPC as the math facts
// app, so a guardian's existing students show up here automatically.

import { supabase } from "./supabase.js";

// Same key the math app uses, so the chosen student persists across
// both apps in the same browser.
const CURRENT_STUDENT_KEY = "vpa-current-student-id";

// Returns the array of students belonging to the current signed-in
// guardian, oldest-first. Returns [] if none exist.
export async function listStudents() {
  const { data, error } = await supabase
    .from("students")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Create a new student via the same RPC the math app uses. The RPC
// inserts the student row AND links it to the guardian in one
// transaction.
export async function createStudent(name, grade) {
  const { data, error } = await supabase.rpc("create_student_for_guardian", {
    p_name: name.trim(),
    p_grade: grade ? parseInt(grade, 10) : null,
  });
  if (error) throw error;
  return data;
}

// Look up a single student by id. Returns null if not found.
export async function getStudentById(id) {
  const { data, error } = await supabase
    .from("students")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

// ----- Local "active student" memory -----

export function rememberCurrentStudent(student) {
  localStorage.setItem(CURRENT_STUDENT_KEY, student.id);
}

export function forgetCurrentStudent() {
  localStorage.removeItem(CURRENT_STUDENT_KEY);
}

export function readCurrentStudentId() {
  return localStorage.getItem(CURRENT_STUDENT_KEY);
}

// Note: an earlier version of this file stored student username +
// password accounts in browser localStorage. That has been replaced by
// real Supabase auth (see signInStudent / signUpStudent in auth.js)
// so passwords are properly hashed and accounts sync across devices.
