// api/coach.js
export const config = { runtime: "edge" };

const DEFAULT_SYSTEM = `
You are a friendly ESL vocabulary coach. Be concise and supportive.
ALWAYS return strict JSON only:
{"assistant":"...","verdict":"correct|incorrect|unsure","explanation":"..."}

Style:
- If correct: praise briefly and (optionally) invite a quick follow-up like "Want to use it in a sentence?"
- If incorrect/unsure: give ONE gentle hint (e.g., first letter and word count or a tiny clue) and end with a short follow-up question inviting another try.
- Never reveal the full answer unless the user explicitly asks to skip/give up.

Tasks you may evaluate:
1) "sentence": Did the learner use the target word/phrase naturally in one sentence? Allow inflections. If missing/misused, say why briefly and show a better mini-example.
2) "name": Given a definition, check if their answer exactly matches the target word/phrase OR any provided alternative (case/spacing/hyphen insensitive).
`;

const ALLOWED = process.env.ALLOWED_ORIGIN || "*";

// ---------- HTTP ----------
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
      system,
      task,
      target,
      definition,
      user_input,
      history = [],
      alternatives = [],
      meta = {}
    } = body || {};

    if (!task || !target || !user_input) {
      return json({
        assistant: "I need a task, target word, and your message.",
        verdict: "unsure",
        explanation: "Missing required fields."
      }, 400, req);
    }

    // If key missing, fall back to offline evaluator so UI still works
    if (!process.env.OPENAI_API_KEY) {
      return json(offlineEvaluate({ task, target, definition, user_input, alternatives }), 200, req);
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const payload = {
      model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: (system || DEFAULT_SYSTEM).trim() },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "Evaluate the learner reply and respond in JSON (no extra text).",
            task,
            target,
            definition,
            user_input,
            alternatives,     // allow variants
            // small meta the model can use for hints if it wants
            meta: {
              wordCount: (String(target).trim().split(/\s+/).filter(Boolean).length),
              firstLetter: String(target).trim()[0] || "",
              ...meta
            },
            history: Array.isArray(history) ? history.slice(-6) : []
          })
        }
      ]
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
      return json(offlineEvaluate({ task, target, definition, user_input, alternatives }), 200, req);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = safeExtractJSON(text) || {};
    return json({
      assistant: parsed.assistant || "Thanks — noted.",
      verdict: parsed.verdict || "unsure",
      explanation: parsed.explanation || ""
    }, 200, req);

  } catch (e) {
    return json({
      assistant: "I couldn't reach the AI right now — try again.",
      verdict: "unsure",
      explanation: "Server error."
    }, 500, req);
  }
}

// ---------- Helpers ----------
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

function normalize(s){ return String(s||"").toLowerCase().replace(/[^\w\s-]/g," ").replace(/\s+/g," ").trim(); }
function sameNormalized(a,b){ return normalize(a) === normalize(b); }

function makeHint(target){
  const words = String(target).trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] || "";
  const wc = words.length;
  return `Hint: starts with “${first}” and has ${wc} word${wc>1?"s":""}.`;
}

function includesWord(text, base){
  const t = " " + normalize(text) + " ";
  const b = normalize(base);
  const forms = [b, b+"s", b+"ed", b+"ing"];
  return forms.some(f => t.includes(" " + f + " "));
}

function offlineEvaluate({ task, target, definition, user_input, alternatives = [] }){
  if (task === "sentence") {
    const ok = target.includes(" ") ? normalize(user_input).includes(normalize(target))
                                    : includesWord(user_input, target);
    return ok
      ? { assistant: "Nice! That uses the word naturally. Want to try another?", verdict: "correct", explanation: "" }
      : { assistant: `Not quite. Try using “${target}” directly in the sentence. ${makeHint(target)} How would you rewrite it?`, verdict: "incorrect", explanation: "Target not clearly used." };
  } else {
    const guess = normalize(user_input);
    const tgt = normalize(target);
    const alts = Array.isArray(alternatives) ? alternatives.map(normalize) : [];
    const ok = guess === tgt || alts.includes(guess);
    return ok
      ? { assistant: `Correct — “${target}”. Want to use it in a sentence?`, verdict: "correct", explanation: "" }
      : { assistant: `Good try, but that doesn't match. ${makeHint(target)} Want to guess again?`, verdict: "incorrect", explanation: "Doesn't match target/alternatives." };
  }
}

function safeExtractJSON(s){
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a>=0 && b>a) { try { return JSON.parse(s.slice(a,b+1)); } catch {} }
  return null;
}
