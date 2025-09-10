// api/coach.js — Chat + Practice (eval) + Small-talk, with CORS and fallbacks
export const config = { runtime: "edge" };

/* ===================== Prompt for eval/chat modes ===================== */
const DEFAULT_SYSTEM = `
You are a friendly ESL vocabulary coach. Sound natural, warm, and brief.
ALWAYS return strict JSON only:
{"assistant":"...","verdict":"correct|incorrect|unsure","explanation":"..."}

Voice:
- Use everyday phrasing. Vary openers: "Nice!", "Great try!", "Almost!", etc.
- 1–2 sentences max. End with a short question to keep the chat moving.
- If incorrect/unsure: give ONE micro-hint (first letter + word count or tiny clue). Invite another try.
- If correct: praise briefly and optionally invite a follow-up (e.g., "Want to use it in a sentence?").

Tasks you may handle:
1) "sentence": learner should use the target word/phrase naturally in one sentence (allow inflections).
2) "name": learner must name the word/phrase from a definition. Accept target OR any provided alternative (case/spacing/hyphen-insensitive).

Mode "chat": reply to small talk (greetings, meta questions) in one short, kind sentence,
then segue back to the exercise with the current prompt. In chat mode set "verdict":"unsure".
`;

const ALLOWED = process.env.ALLOWED_ORIGIN || "*";

/* ============================== Handler ============================== */
export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, req);
  }

  try {
    const body = await req.json();
    const {
      mode = "eval",          // "general" | "chat" | "eval"
      task,                   // "sentence" | "name"  (not needed for "general")
      target,                 // (not needed for "general")
      definition,
      user_input,
      history = [],
      alternatives = [],
      meta = {},
      system
    } = body || {};

    /* ---------- NEW: Handle general ChatGPT-like mode up front ---------- */
    if (mode === "general") {
      if (!process.env.OPENAI_API_KEY) {
        // Offline fallback so UI still responds
        return json({
          assistant: "Hi! (general chat is offline on this deployment.)",
          verdict: "chat",
          explanation: ""
        }, 200, req);
      }

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.7,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are a warm, concise assistant. Reply in 1–5 sentences. Use markdown when helpful. " +
                "ALWAYS return JSON only: {\"assistant\":\"...\",\"verdict\":\"chat\",\"explanation\":\"\"}."
            },
            ...(Array.isArray(history)
              ? history.map(m => ({
                  role: m.role === "assistant" ? "assistant" : "user",
                  content: m.content
                }))
              : []),
            { role: "user", content: user_input || "" }
          ]
        })
      });

      if (!res.ok) {
        return json(
          { assistant: "Sorry — general chat is unavailable right now.", verdict: "chat", explanation: "" },
          200,
          req
        );
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "";
      const out = safeJSON(text) || { assistant: text || "Thanks!", verdict: "chat", explanation: "" };
      return json(out, 200, req);
    }

    /* ---------- Validation for non-general modes ---------- */
    if (!task || !target || !user_input) {
      return json({
        assistant: "Missing task/target/user_input.",
        verdict: "unsure",
        explanation: ""
      }, 400, req);
    }

    /* ---------- Offline fallback if no API key ---------- */
    if (!process.env.OPENAI_API_KEY) {
      const out = (mode === "chat")
        ? { assistant: segueLine(target, task), verdict: "unsure", explanation: "" }
        : offlineEvaluate({ task, target, definition, user_input, alternatives });
      return json(out, 200, req);
    }

    /* ---------- Few-shot style guides (tone + JSON discipline) ---------- */
    const shots = [
      // name: correct
      [
        { mode:"eval", task:"name", target:"diet", definition:"The usual food and drink a person eats.", user_input:"diet" },
        { assistant:"Nice — “diet” fits that. Want to use it in a sentence?", verdict:"correct", explanation:"" }
      ],
      // name: incorrect
      [
        { mode:"eval", task:"name", target:"junk food", definition:"Food high in sugar, salt, or fat and low in nutrients.", user_input:"snack", alternatives:["junk-food"] },
        { assistant:"Close, but not quite. Hint: two words, starts with “j”. Another guess?", verdict:"incorrect", explanation:"" }
      ],
      // sentence: correct
      [
        { mode:"eval", task:"sentence", target:"reduce", user_input:"I’m trying to reduce how much sugar I drink each day." },
        { assistant:"Great — “reduce” is used naturally there. Ready for the next one?", verdict:"correct", explanation:"" }
      ],
      // chat: small talk segue
      [
        { mode:"chat", task:"sentence", target:"consume", user_input:"hi there" },
        { assistant:"Hey! Happy to chat — now let’s keep practicing: try using “consume” in a sentence.", verdict:"unsure", explanation:"" }
      ]
    ];

    const userPayload = {
      instruction: "Respond in JSON only (no extra text).",
      mode, task, target, definition, user_input,
      alternatives,
      history: Array.isArray(history) ? history.slice(-6) : [],
      meta: {
        wordCount: wc(target),
        firstLetter: (target || "")[0] || "",
        ...meta
      }
    };

    const messages = [
      { role: "system", content: (system || DEFAULT_SYSTEM).trim() },
      ...shots.flatMap(([u, a]) => ([
        { role: "user", content: JSON.stringify(u) },
        { role: "assistant", content: JSON.stringify(a) }
      ])),
      { role: "user", content: JSON.stringify(userPayload) }
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages
      })
    });

    if (!res.ok) {
      const out = (mode === "chat")
        ? { assistant: segueLine(target, task), verdict: "unsure", explanation: "" }
        : offlineEvaluate({ task, target, definition, user_input, alternatives });
      return json(out, 200, req);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJSON(text) || {};
    return json({
      assistant: parsed.assistant || segueLine(target, task),
      verdict: parsed.verdict || (mode === "chat" ? "unsure" : "unsure"),
      explanation: parsed.explanation || ""
    }, 200, req);

  } catch (e) {
    return json({
      assistant: "I couldn’t reach the AI right now — try again.",
      verdict: "unsure",
      explanation: "Server error."
    }, 500, req);
  }
}

/* ============================== Helpers ============================== */
function corsHeaders(req) {
  const origin = req.headers.get("origin") || "*";
  const allow = (ALLOWED === "*" || origin === ALLOWED) ? origin : ALLOWED;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}
function json(obj, status, req) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) }
  });
}
const norm = s => String(s || "").toLowerCase().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
const wc = s => String(s || "").trim().split(/\s+/).filter(Boolean).length;
function includesWord(text, base) {
  const T = " " + norm(text) + " ";
  const b = norm(base);
  return [b, b + "s", b + "ed", b + "ing"].some(f => T.includes(" " + f + " "));
}
function segues(t, task) {
  return task === "sentence"
    ? `Let’s keep going: try using “${t}” in a natural sentence.`
    : `Your turn — which word matches the definition for “${t}”?`;
}
function segueLine(t, task) { return `Happy to chat! ${segues(t, task)}`; }

function offlineEvaluate({ task, target, definition, user_input, alternatives = [] }) {
  if (task === "sentence") {
    const ok = target.includes(" ")
      ? norm(user_input).includes(norm(target))
      : includesWord(user_input, target);
    return ok
      ? { assistant: "Nice — that sounds natural. Ready for the next one?", verdict: "correct", explanation: "" }
      : {
          assistant: `Almost — try using “${target}” directly. Hint: starts with “${(target || "")[0] || ""}”, ${wc(target)} word(s). Another try?`,
          verdict: "incorrect",
          explanation: "Target not clearly used."
        };
  } else {
    const guess = norm(user_input), tgt = norm(target), alts = (alternatives || []).map(norm);
    const ok = guess === tgt || alts.includes(guess);
    return ok
      ? { assistant: `Great, it’s “${target}”. Want to put it in a sentence?`, verdict: "correct", explanation: "" }
      : {
          assistant: `Not quite. Hint: starts with “${(target || "")[0] || ""}”, ${wc(target)} word(s). Another guess?`,
          verdict: "incorrect",
          explanation: "Doesn’t match target/alternatives."
        };
  }
}
function safeJSON(s) {
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}
