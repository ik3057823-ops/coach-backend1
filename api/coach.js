// api/coach.js (chatty coach + few-shot + alternatives)
export const config = { runtime: "edge" };

const DEFAULT_SYSTEM = `
You are a friendly ESL vocabulary coach. Sound natural, encouraging, and brief.
ALWAYS return strict JSON only:
{"assistant":"...","verdict":"correct|incorrect|unsure","explanation":"..."}

Voice & style (very important):
- Use everyday phrasing, not bureaucratic language.
- Vary openers: "Nice!", "Great job!", "Solid try!", "Almost!", "Good catch!" etc.
- 1–2 sentences max. End with a small question to keep the chat moving.
- If incorrect/unsure: give ONE tiny hint (first letter and word count, or a micro-clue). Invite another try.
- If correct: celebrate briefly and optionally invite a quick follow-up (e.g., "Want to use it in a sentence?").

Tasks you may evaluate:
1) "sentence": Did the learner use the target word/phrase naturally in one sentence? Allow inflections. If missing/misused, say why briefly and show a short better mini-example.
2) "name": Given a definition, the learner must name the word/phrase. Count correct if it matches the target OR any provided alternative
   (case/spacing/hyphen-insensitive).
`;

const ALLOWED = process.env.ALLOWED_ORIGIN || "*";

// ---- HTTP handler ----
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
      task,
      target,
      definition,
      user_input,
      history = [],
      alternatives = [],
      meta = {},
      system
    } = body || {};

    if (!task || !target || !user_input) {
      return json({
        assistant: "I need a task, target word, and your message.",
        verdict: "unsure",
        explanation: "Missing required fields."
      }, 400, req);
    }

    // If no key, use offline evaluator so UI still works.
    if (!process.env.OPENAI_API_KEY) {
      return json(offlineEvaluate({ task, target, definition, user_input, alternatives }), 200, req);
    }

    // -------- Few-shot style guides (model learns tone) --------
    const shots = [
      // name: correct
      [
        { task:"name", target:"diet", definition:"The usual food and drink a person eats.", user_input:"diet", alternatives:[] },
        { assistant:"Nice! “diet” fits that definition. Want to use it in a sentence?", verdict:"correct", explanation:"" }
      ],
      // name: incorrect
      [
        { task:"name", target:"junk food", definition:"Food high in sugar, salt, or fat and low in nutrients.", user_input:"snack", alternatives:["junk-food"] },
        { assistant:"Close, but not quite. Hint: it’s two words and starts with “j”. Another guess?", verdict:"incorrect", explanation:"" }
      ],
      // sentence: correct
      [
        { task:"sentence", target:"reduce", definition:"To make smaller or less.", user_input:"I’m trying to reduce how much sugar I drink each day.", alternatives:[] },
        { assistant:"Great—“reduce” is used naturally there. Want to try another word?", verdict:"correct", explanation:"" }
      ],
      // sentence: incorrect
      [
        { task:"sentence", target:"diet", definition:"The usual food and drink a person eats.", user_input:"I like food.", alternatives:[] },
        { assistant:"I don’t see “diet” yet. Try using it directly, e.g., “Since January I changed my diet to include more whole foods.” Give it another shot?", verdict:"incorrect", explanation:"" }
      ]
    ];

    const messages = [
      { role: "system", content: (system || DEFAULT_SYSTEM).trim() },
      // few-shots
      ...shots.flatMap(([u,a]) => ([
        { role: "user", content: JSON.stringify(u) },
        { role: "assistant", content: JSON.stringify(a) }
      ])),
      // live turn
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Evaluate the learner reply and respond in JSON.",
          task, target, definition, user_input,
          alternatives,
          history: Array.isArray(history) ? history.slice(-6) : [],
          meta: {
            wordCount: String(target).trim().split(/\s+/).filter(Boolean).length,
            firstLetter: String(target).trim()[0] || "",
            styleVariant: Math.ceil(Math.random()*3), // tiny variety
            ...meta
          }
        })
      }
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.7,
        messages
      })
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
      assistant: "I couldn’t reach the AI right now — try again.",
      verdict: "unsure",
      explanation: "Server error."
    }, 500, req);
  }
}

// ---- helpers ----
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
function includesWord(text, base){ const t=" "+normalize(text)+" "; const b=normalize(base); return [b,b+"s",b+"ed",b+"ing"].some(f => t.includes(" "+f+" ")); }
function makeHint(target){ const words=String(target).trim().split(/\s+/).filter(Boolean); const first=words[0]?.[0]||""; const wc=words.length; return `Hint: starts with “${first}” and has ${wc} word${wc>1?"s":""}.`; }
function offlineEvaluate({ task, target, definition, user_input, alternatives=[] }){
  if (task === "sentence") {
    const ok = target.includes(" ") ? normalize(user_input).includes(normalize(target)) : includesWord(user_input, target);
    return ok
      ? { assistant:"Nice! That sounds natural. Want to try another?", verdict:"correct", explanation:"" }
      : { assistant:`Almost—try using “${target}” directly. ${makeHint(target)} Your turn again?`, verdict:"incorrect", explanation:"Target not clearly used." };
  } else {
    const guess = normalize(user_input), tgt = normalize(target), alts = (alternatives||[]).map(normalize);
    const ok = (guess===tgt) || alts.includes(guess);
    return ok
      ? { assistant:`Great, it’s “${target}”. Want to put it in a sentence?`, verdict:"correct", explanation:"" }
      : { assistant:`Not quite. ${makeHint(target)} Another guess?`, verdict:"incorrect", explanation:"Doesn’t match target/alternatives." };
  }
}
function safeExtractJSON(s){ try{return JSON.parse(s);}catch{} const a=s.indexOf("{"), b=s.lastIndexOf("}"); if(a>=0&&b>a){ try{return JSON.parse(s.slice(a,b+1));}catch{} } return null; }
