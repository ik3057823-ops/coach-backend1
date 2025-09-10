// If the client asks for general chat, just be helpful.
if (body?.mode === "general") {
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
        { role: "system", content:
          "You are a warm, concise assistant. Reply in 1–5 sentences. Use markdown when helpful. ALWAYS return JSON only: {\"assistant\":\"...\",\"verdict\":\"chat\",\"explanation\":\"\"}."
        },
        // pass the running history if you like (optional)
        ...(Array.isArray(body.history) ? body.history.map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content
        })) : []),
        { role: "user", content: body.user_input || "" }
      ]
    })
  });

  if (!res.ok) {
    return new Response(JSON.stringify({
      assistant: "Sorry—can’t reach the model right now.",
      verdict: "chat",
      explanation: ""
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(req) }});
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  let out;
  try { out = JSON.parse(text); } catch { out = { assistant: text, verdict: "chat", explanation: "" }; }
  return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(req) }});
}
