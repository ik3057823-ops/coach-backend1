// api/coach.js
// Vercel Edge Function with CORS + OpenAI call + safe fallback.
// Endpoint: POST /api/coach  ->  { assistant, verdict, explanation }

export const config = { runtime: "edge" }; // use the Web Request/Response API

const DEFAULT_SYSTEM = `
You are a friendly ESL vocabulary coach. Keep replies brief (1–2 sentences).
Return strict JSON only: {"assistant":"...","verdict":"correct|incorrect|unsure","explanation":"..."}.
Tasks:
1) "sentence": Check if the learner used the target word/phrase naturally in one sentence. Allow inflections. If missing or misused, say why briefly and offer a short better example.
2) "name": Given a definition, check if their answer exactly matches the target word/phrase (accept minor spacing/hyphen variants if meaning is the same).
`;

const ALLOWED = process.env.ALLOWED_ORIGIN || "*"; // set to your Pages origin later

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }
  if (req.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  try {
    const { system, task, target, definition, user_input, history = [] } = await req.json();

    if (!task || !target || !user_input) {
      return new Response(JSON.stringify({
        assistant: "I need a task, target word, and your message.",
        verdict: "unsure",
        explanation: "Missing required fields."
      }), { status: 400, headers });
    }

    // If no key, fall back so the UI still works.
    if (!process.env.OPENAI_API_KEY) {
      const offline = offlineEvaluate({ task, target, definition, user_input });
      return new Response(JSON.stringify(offline), { headers });
    }

    // ---- OpenAI Chat Completions (JSON mode) ----
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const payload = {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: (system || DEFAULT_SYSTEM).trim() },
        { role: "user", content: JSON.stringify({
            instruction: "Evaluate the learner reply for the given vocabulary task and respond in JSON.",
            task, target, definition, user_input,
            history: Array.isArray(history) ? history.slice(-6) : []
        }) }
      ],
      temperature: 0.2
    };

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const offline = offlineEvaluate({ task, target, definition, user_input });
      return new Response(JSON.stringify(offline), { headers });
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    let parsed = safeExtractJSON(text) || {};
    const out = {
      assistant: parsed.assistant || "Thanks — noted.",
      verdict: parsed.verdict || "unsure",
      explanation: parsed.explanation || ""
    };
    return new Response(JSON.stringify(out), { headers });

  } catch (e) {
    return new Response(JSON.stringify({
      assistant: "I couldn't reach the AI right now — try again.",
      verdict: "unsure",
      explanation: "Server error."
    }), { status: 500, headers });
  }
}

// ---------- Helpers ----------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
}
function includesPhrase(text, phrase) { return normalize(text).includes(normalize(phrase)); }
function includesWord(text, base) {
  const t = " " + normalize(text) + " ";
  const b = normalize(base);
  const forms = new Set([b, b + "s", b + "ed", b + "ing"]);
  for (const f of forms) if (t.includes(" " + f + " ")) return true;
  return false;
}
function offlineEvaluate({ task, target, definition, user_input }) {
  if (task === "sentence") {
    const ok = target.includes(" ") ? includesPhrase(user_input, target) : includesWord(user_input, target);
    return ok
      ? { assistant: "Nice! That uses the word naturally. ✅", verdict: "correct", explanation: "" }
      : { assistant: `I didn’t clearly see “${target}”. Try one more time mentioning it directly.`, verdict: "incorrect", explanation: "The target word/phrase should appear in the sentence." };
  } else {
    const ok = normalize(user_input) === normalize(target);
    return ok
      ? { assistant: `Correct — “${target}”. ✅`, verdict: "correct", explanation: "" }
      : { assistant: `Not quite — the word was “${target}”.`, verdict: "incorrect", explanation: "Compare the definition with the target word." };
  }
}
function safeExtractJSON(s) {
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}
