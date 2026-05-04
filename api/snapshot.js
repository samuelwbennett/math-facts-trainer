// api/snapshot.js
//
// Temporary test endpoint for VPA dashboard.
// This proves the API route works before we connect real student data.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const studentId = req.query.student || "demo-student";

  return res.status(200).json({
    studentId,
    todayXp: 10,
    weekXp: 50,
    dailyGoalXp: 30,
    nextDrill: {
      label: "Addition within 20",
      path: "/#/drill/add-20"
    }
  });
}