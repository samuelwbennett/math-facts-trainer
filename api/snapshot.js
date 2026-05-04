import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const hasUrl = Boolean(process.env.SUPABASE_URL);
    const hasKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!hasUrl || !hasKey) {
      return res.status(200).json({
        step: "env_check",
        hasSupabaseUrl: hasUrl,
        hasServiceRoleKey: hasKey,
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("daily_progress")
      .select("*")
      .limit(1);

    if (error) {
      return res.status(200).json({
        step: "query_error",
        error: error.message,
      });
    }

    return res.status(200).json({
      step: "success",
      sampleRow: data,
    });

  } catch (err) {
    return res.status(200).json({
      step: "crash",
      error: err.message,
    });
  }
}