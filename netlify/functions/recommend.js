export default async (req) => {
  try {
    const body = await req.json();

    const userPrompt = `
    You are a heating system design assistant.
    Based on the input below, recommend TWO suitable heating/hot-water system types.
    Be concise, technical, and evidence-based.
    Input: ${JSON.stringify(body, null, 2)}
    Respond in JSON with this shape:
    {
      "recommendations": [
        {"title": "system name", "reason": "why it's suitable"}
      ]
    }
    `;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!r.ok) {
      const text = await r.text();
      return new Response(JSON.stringify({ error: text }), { status: 500 });
    }

    const data = await r.json();
    return new Response(data.choices[0].message.content, {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};